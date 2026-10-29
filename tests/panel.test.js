import test from 'node:test'
import assert from 'node:assert/strict'
import { createState } from '../src/state.js'
import { createPanelController } from '../src/ui/panel.js'

// Minimal DOM surface used by the production panel; no UI implementation is mocked.
class Element {
  constructor(tagName, document) {
    Object.assign(this, { tagName, document, children: [], style: {}, dataset: {}, attributes: {}, listeners: {}, hidden: false })
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
  replaceChildren() { for (const child of this.children) child.parentElement = null; this.children = [] }
  get isConnected() { return this === this.document.documentElement || Boolean(this.parentElement?.isConnected) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler) }
  matches(selector) {
    if (selector === '[data-participant-key]') return this.dataset.participantKey !== undefined
    const role = selector.match(/^\[data-role="(.+)"\]$/)
    return role ? this.dataset.role === role[1] : selector.split(', ').includes(this.tagName)
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  focus() { this.document.activeElement = this }
  click() { this.onclick?.({ target: this }) }
  getBoundingClientRect() { return { left: 12, top: 72 } }
}

function fixture(t) {
  const originalDocument = globalThis.document
  const originalAddEventListener = globalThis.addEventListener
  const events = {}
  const document = { activeElement: null }
  document.documentElement = new Element('html', document)
  document.createElement = tag => new Element(tag, document)
  document.getElementById = id => [document.documentElement, ...document.documentElement.querySelectorAll('div')].find(element => element.id === id) ?? null
  globalThis.document = document
  globalThis.addEventListener = (name, handler) => { events[name] = handler }
  t.after(() => { globalThis.document = originalDocument; globalThis.addEventListener = originalAddEventListener })
  const state = createState({ getItem: () => null })
  state.platform = 'google-meet'
  const alice = { key: 'alice', name: 'Alice', platform: 'google-meet', value: 2.5 }
  const people = [alice]
  const gains = [], saves = []
  const controller = createPanelController(state, { participants: () => people, onGain: (person, value) => { gains.push([person.key, value]); person.value = value }, onSave: position => saves.push(position) })
  controller.render()
  const parts = () => {
    const [header, body] = state.panel.children
    const buttons = header.querySelectorAll('button')
    return { header, body, collapse: buttons[0], close: buttons[1] }
  }
  return { state, controller, parts, document, events, gains, saves, people, alice }
}

function assertExpanded({ header, body, collapse }, expanded) {
  assert.equal(body.hidden, !expanded)
  assert.equal(collapse.getAttribute('aria-expanded'), String(expanded))
  assert.equal(collapse.getAttribute('aria-controls'), body.id)
  assert.ok(body.id)
  assert.equal(collapse.getAttribute('aria-label'), expanded ? 'Collapse panel' : 'Expand panel')
  assert.equal(collapse.title, expanded ? 'Collapse panel' : 'Expand panel')
  assert.equal(header.style.marginBottom, expanded ? '8px' : '0')
}

test('panel starts expanded with collapse immediately left of close and one complete body', t => {
  const { state, parts } = fixture(t)
  assert.equal(state.panelCollapsed, false)
  const { header, body, collapse, close } = parts()
  assert.equal(state.panel.children.length, 2)
  assert.equal(collapse.tagName, 'button')
  assert.equal(close.textContent, '×')
  assert.deepEqual(collapse.parentElement.children, [collapse, close])
  assert.equal(header.children[0].children[0].textContent, 'Google Meet Audio Booster')
  assert.match(header.children[0].children[1].textContent, /1 participant/)
  assert.equal(body.children.length, 3)
  assert.equal(body.children[0].querySelectorAll('[data-participant-key]').length, 1)
  assert.equal(body.children[1].querySelector('button').textContent, 'Reset all')
  assert.equal(body.children[2].textContent, state.status)
  assertExpanded(parts(), true)
})

test('collapse toggles twice in place, preserves focus and never starts drag or gain/save callbacks', t => {
  const { state, parts, document, events, gains, saves } = fixture(t)
  const original = parts()
  original.collapse.focus()
  original.header.onmousedown({ target: original.collapse, preventDefault() { assert.fail('button must not start drag') } })
  original.collapse.click()
  events.mousemove({ clientX: 100, clientY: 100 })
  events.mouseup()
  assert.equal(state.panelCollapsed, true)
  assertExpanded(parts(), false)
  assert.equal(document.activeElement, original.collapse)
  assert.equal(parts().header, original.header)
  assert.equal(parts().body, original.body)
  assert.equal(state.panel.__boosterDrag, undefined)
  assert.equal(parts().header.children[0].children.length, 2)
  original.collapse.click()
  assertExpanded(parts(), true)
  assert.equal(state.panelCollapsed, false)
  assert.equal(parts().collapse, original.collapse)
  assert.deepEqual(gains, [])
  assert.deepEqual(saves, [])
})

test('rerender, live updates and toolbar hide/show retain collapse; reset and close still work', t => {
  const { state, controller, parts, gains, people, alice } = fixture(t)
  parts().collapse.click()
  const bodyId = parts().body.id
  people.push({ key: 'bob', name: 'Bob', platform: 'google-meet', value: 0.5 })
  state.status = 'Updated status'
  controller.render()
  assertExpanded(parts(), false)
  assert.equal(parts().body.id, bodyId)
  assert.match(parts().header.children[0].children[1].textContent, /2 participants/)
  assert.equal(parts().body.children[2].textContent, 'Updated status')
  alice.value = 3
  controller.updateLiveUi()
  assert.equal(state.panel.querySelector('[data-role="value"]').textContent, '300%')
  controller.toggle()
  assert.equal(state.closed, true)
  assert.equal(state.panel.style.display, 'none')
  controller.toggle()
  assert.equal(state.closed, false)
  assert.equal(state.panel.style.display, 'block')
  assertExpanded(parts(), false)
  parts().collapse.click()
  parts().body.children[1].querySelector('button').click()
  assert.deepEqual(gains, [['alice', 1], ['bob', 1]])
  assertExpanded(parts(), true)
  parts().close.click()
  assert.equal(state.closed, true)
  assert.equal(state.panel.style.display, 'none')
  assert.equal(createState({ getItem: () => null }).panelCollapsed, false)
})
