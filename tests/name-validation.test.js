import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidParticipantName, extractNameFromParticipantRoot } from '../src/shared/dom.js'

for (const value of ['', '   ', 'keep_outline', 'mic_off', 'more_vert', 'call_end', 'volume_up', 'person', 'group', 'Meeting details', 'More options']) {
  test(`rejects non-participant token: ${JSON.stringify(value)}`, () => {
    assert.equal(isValidParticipantName(value), false)
  })
}

for (const value of ['Alice Smith', 'Élodie', '李雷', "O'Connor", 'Anne-Marie']) {
  test(`accepts participant name: ${value}`, () => {
    assert.equal(isValidParticipantName(value), true)
  })
}

test('does not accept arbitrary descendant button labels or chat text', () => {
  const root = {
    getAttribute(name) { return name === 'data-participant-id' ? 'p1' : null },
    querySelectorAll() {
      return [
        { matches: () => true, getAttribute: name => name === 'aria-label' ? 'keep_outline' : null, textContent: 'keep_outline' },
        { matches: () => false, getAttribute: () => null, textContent: 'hello from chat' }
      ]
    }
  }
  assert.equal(extractNameFromParticipantRoot(root), null)
})

test('collapses duplicate name spans inside a recognized Meet name wrapper', () => {
  const duplicate = [
    { textContent: 'FirstNameLastName' },
    { textContent: 'FirstNameLastName' }
  ]
  const root = {
    getAttribute(name) { return name === 'data-participant-id' ? 'p1' : null },
    querySelectorAll() {
      return [{
        matches: selector => selector.includes('.zWGUib') && !selector.includes('button'),
        getAttribute: () => null,
        textContent: 'FirstNameLastNameFirstNameLastName',
        children: duplicate
      }]
    }
  }
  assert.equal(extractNameFromParticipantRoot(root), 'FirstNameLastName')
})

test('accepts a name only from a recognized participant name element', () => {
  const root = {
    getAttribute(name) { return name === 'data-participant-id' ? 'p1' : null },
    querySelectorAll() {
      return [{ matches: selector => selector.includes('data-self-name'), getAttribute: () => null, textContent: 'Alice Smith' }]
    }
  }
  assert.equal(extractNameFromParticipantRoot(root), 'Alice Smith')
})
