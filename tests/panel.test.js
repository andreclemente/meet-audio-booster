import test from 'node:test'
import assert from 'node:assert/strict'
import { createState } from '../src/state.js'
import { createPanelController } from '../src/ui/panel.js'
import { saveSettings } from '../src/storage.js'
import { PANEL_ID } from '../src/shared/constants.js'

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
  getBoundingClientRect() { return { left: parseFloat(this.style.left) || 12, top: parseFloat(this.style.top) || 72, width: 300, height: 200 } }
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
  const gains = [], saves = [], collapses = []
  const controller = createPanelController(state, { participants: () => people, onGain: (person, value) => { gains.push([person.key, value]); person.value = value }, onSave: position => saves.push(position), onCollapse: value => collapses.push(value) })
  controller.render()
  const parts = () => {
    const [header, body] = state.panel.children
    const buttons = header.querySelectorAll('button')
    return { header, body, collapse: buttons[0], close: buttons[1] }
  }
  return { state, controller, parts, document, events, gains, saves, collapses, people, alice }
}

test('existing controls have participant-specific accessible names and close label', t => {
  const { state, parts } = fixture(t)
  assert.equal(parts().close.getAttribute('aria-label'), 'Close panel')
  assert.equal(state.panel.querySelector('[data-role="slider"]').getAttribute('aria-label'), 'Volume for Alice')
  const presets = state.panel.querySelectorAll('[data-participant-key]')[0].querySelectorAll('button')
  assert.deepEqual(presets.map(button => button.getAttribute('aria-label')), ['Mute for Alice', '50% for Alice', '100% for Alice', '250% for Alice'])
})

test('roster rerender restores focused participant control without changing gain', t => {
  const { state, controller, document, people, gains, parts } = fixture(t)
  for (const getControl of [() => state.panel.querySelector('[data-role="slider"]'), () => state.panel.querySelectorAll('[data-participant-key]')[0].querySelectorAll('button')[2], () => parts().collapse, () => parts().close, () => parts().body.children[1].querySelector('button')]) {
    const before = getControl()
    before.focus()
    if (people.length === 1) people.push({ key: 'bob', name: 'Bob', platform: 'google-meet', value: 1 })
    controller.render()
    assert.notEqual(document.activeElement, before)
    assert.equal(document.activeElement, getControl())
  }
  assert.deepEqual(gains, [])
})

test('rerender does not steal focus from another page control with a matching participant key', t => {
  const { document, controller } = fixture(t)
  const row = document.createElement('div'); row.dataset.participantKey = 'alice'
  const input = document.createElement('input'); row.append(input); document.documentElement.append(row)
  input.focus(); controller.render()
  assert.equal(document.activeElement, input)
})

test('focus follows participant key after roster reorder, not row index or display name', t => {
  const { state, document, controller, people } = fixture(t)
  state.panel.querySelector('[data-role="slider"]').focus()
  people.unshift({ key: 'different-alice', name: 'Alice', platform: 'google-meet', value: 1 })
  controller.render()
  assert.equal(document.activeElement.closest('[data-participant-key]').dataset.participantKey, 'alice')
})

test('saved panel position recovers inside viewport on render and resize', t => {
  const { state, controller, events, saves } = fixture(t)
  const width = globalThis.innerWidth, height = globalThis.innerHeight
  t.after(() => { globalThis.innerWidth = width; globalThis.innerHeight = height })
  globalThis.innerWidth = 800; globalThis.innerHeight = 600
  state.settings.position = { left: 5000, top: 5000 }
  controller.render()
  assert.equal(state.panel.style.left, '492px')
  assert.equal(state.panel.style.top, '392px')
  globalThis.innerWidth = 400; globalThis.innerHeight = 300
  events.resize()
  assert.equal(state.panel.style.left, '92px')
  assert.equal(state.panel.style.top, '92px')
  assert.deepEqual(saves, [])
})

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
  assert.equal(body.children[1].children[0].textContent, state.status)
  assert.equal(body.children[2].textContent, 'Support development')
  assertExpanded(parts(), true)
})

test('collapse toggles in place, preserves focus and only calls dedicated collapse callback', t => {
  const { state, parts, document, events, gains, saves, collapses } = fixture(t)
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
  assert.deepEqual(collapses, [true, false])
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
  assert.equal(state.panel.querySelectorAll('div').find(node => node.id === `${PANEL_ID}_status`).textContent, 'Updated status')
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

test('collapse callback is optional and storage failure cannot block immediate UI or focus', t => {
  const { state, parts, people, document } = fixture(t)
  for (const storage of [null, { setItem() { throw new Error('quota') } }]) {
    const controller = createPanelController(state, {
      participants: () => people, onGain() { assert.fail('no gain changes') }, onSave() { assert.fail('no position saves') },
      onCollapse: collapsed => {
        assertExpanded(parts(), !collapsed)
        state.settings.collapsed = collapsed
        assert.equal(saveSettings(storage, state.settings), false)
      }
    })
    controller.render()
    const original = parts()
    original.collapse.focus()
    original.collapse.click()
    assert.equal(document.activeElement, original.collapse)
    assert.equal(parts().body, original.body)
    assert.equal(state.settings.collapsed, state.panelCollapsed)
  }
  const controller = createPanelController(state, { participants: () => people, onGain() {}, onSave() {} })
  controller.render()
  const before = state.panelCollapsed
  parts().collapse.click()
  assert.equal(state.panelCollapsed, !before)
  assertExpanded(parts(), before)
})

test('approved support layout keeps exact dynamic status left of Reset all and support below', t => {
  const { parts, state, document } = fixture(t)
  const [list, footer, support] = parts().body.children
  const status = document.getElementById(`${PANEL_ID}_status`)
  assert.equal(list.querySelectorAll('[data-participant-key]').length, 1)
  assert.deepEqual(footer.children, [status, footer.querySelector('button')])
  assert.equal(footer.style.justifyContent, 'space-between')
  assert.equal(status.textContent, state.status)
  assert.equal(status.style.marginTop, '0')
  assert.equal(status.style.minWidth, '0')
  assert.equal(status.style.overflow, 'hidden')
  assert.equal(status.style.textOverflow, 'ellipsis')
  assert.equal(status.style.whiteSpace, 'nowrap')
  assert.equal(footer.querySelector('button').style.flex, '0 0 auto')
  assert.equal(support.tagName, 'a')
  assert.equal(support.textContent, 'Support development')
  assert.equal(support.style.marginTop, '7px')
  assert.equal(support.style.lineHeight, '14px')
  assert.equal(support.style.minHeight, '14px')
})

test('support is an inert plain secure outbound link with optional free-feature tooltip', t => {
  const { state } = fixture(t)
  const link = state.panel.querySelector('a')
  assert.ok(link)
  assert.equal(link.href, 'https://buymeacoffee.com/andreclemente')
  assert.equal(link.target, '_blank')
  assert.equal(link.rel, 'noopener noreferrer')
  assert.equal(link.referrerPolicy, 'no-referrer')
  assert.equal(link.title, 'Optional support — all features remain free')
  assert.equal(link.onclick, undefined)
  assert.equal(state.panel.querySelectorAll('iframe, script, img').length, 0)
})

test('status retains its full dynamic text without live speaker announcements', t => {
  const { state, document, controller } = fixture(t)
  const status = document.getElementById(`${PANEL_ID}_status`)
  const message = 'Participant with a very long name · automatic routing '.repeat(20)
  // Same existing ID/textContent update contract as main.setStatus.
  state.status = message
  status.textContent = message
  assert.equal(status.textContent, message)
  assert.equal(status.getAttribute('aria-live'), null)
  assert.equal(status.getAttribute('role'), null)
  controller.render()
  assert.equal(document.getElementById(`${PANEL_ID}_status`).textContent, message)
  assert.equal(state.panel.querySelector('a').textContent, 'Support development')
})

test('complete collapsed body contains support and status across roster rerender and reset', t => {
  const { state, parts, controller, people, gains } = fixture(t)
  parts().collapse.click()
  people.push({ key: 'bob', name: 'Bob', platform: 'google-meet', value: 0.5 })
  controller.render()
  assertExpanded(parts(), false)
  assert.equal(state.panel.querySelector('a').parentElement, parts().body)
  assert.equal(parts().body.children[1].children[0].id, `${PANEL_ID}_status`)
  parts().collapse.click()
  parts().body.children[1].querySelector('button').click()
  assert.deepEqual(gains, [['alice', 1], ['bob', 1]])
  assertExpanded(parts(), true)
  assert.equal(state.panel.querySelectorAll('a').length, 1)
})

test('support link focus survives roster render and live updates without gain side effects', t => {
  const { state, controller, document, people, gains } = fixture(t)
  const link = state.panel.querySelector('a')
  assert.ok(link)
  link.focus()
  people.push({ key: 'bob', name: 'Bob', platform: 'google-meet', value: 1 })
  controller.render()
  assert.equal(document.activeElement, state.panel.querySelector('a'))
  assert.notEqual(document.activeElement, link)
  controller.updateLiveUi()
  assert.equal(document.activeElement, state.panel.querySelector('a'))
  assert.deepEqual(gains, [])
})

test('support focus restoration never steals page anchor focus', t => {
  const { document, controller } = fixture(t)
  const anchor = document.createElement('a')
  anchor.textContent = 'Support development'
  anchor.href = 'https://example.invalid/'
  document.documentElement.append(anchor)
  anchor.focus()
  controller.render()
  assert.equal(document.activeElement, anchor)
})

test('departed participant focus never falls back to support or same-name participant', t => {
  const { state, controller, document, people } = fixture(t)
  const slider = state.panel.querySelector('[data-role="slider"]')
  slider.focus()
  people.splice(0, 1, { key: 'new-alice', name: 'Alice', platform: 'google-meet', value: 1 })
  controller.render()
  assert.notEqual(document.activeElement, state.panel.querySelector('a'))
  assert.notEqual(document.activeElement, state.panel.querySelector('[data-role="slider"]'))
})

test('only dragging calls position save, not collapse callback', t => {
  const { parts, events, saves, collapses } = fixture(t)
  parts().header.onmousedown({ target: parts().header, clientX: 10, clientY: 20, preventDefault() {} })
  events.mousemove({ clientX: 40, clientY: 60 })
  events.mouseup()
  assert.deepEqual(saves, [{ left: 42, top: 112 }])
  assert.deepEqual(collapses, [])
})
