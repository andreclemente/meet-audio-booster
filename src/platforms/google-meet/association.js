import { ASSOCIATION_CONFIRMATIONS } from '../../shared/constants.js'

export function createAssociationLearner(confirmations = ASSOCIATION_CONFIRMATIONS) {
  const records = new Map()
  return {
    observe(pipelineId, participantKey, { exclusiveUi = false, exclusiveEnergy = false } = {}) {
      if (!pipelineId || !participantKey || !exclusiveUi || !exclusiveEnergy) return this.get(pipelineId)
      const old = records.get(pipelineId)
      const record = old?.candidate === participantKey
        ? { ...old, count: old.count + 1 }
        : { candidate: participantKey, count: 1, participantKey: null, associationReliable: false }
      if (record.count >= confirmations) {
        record.participantKey = participantKey
        record.associationReliable = true
      }
      records.set(pipelineId, record)
      return { participantKey: record.participantKey, associationReliable: record.associationReliable }
    },
    get(pipelineId) {
      const record = records.get(pipelineId)
      return { participantKey: record?.participantKey || null, associationReliable: Boolean(record?.associationReliable) }
    },
    forget(pipelineId) { records.delete(pipelineId) },
    clear() { records.clear() }
  }
}

export function createFreshAlignmentTracker({ freshMs = 150 } = {}) {
  let uiKey = null
  let energyId = null
  let uiChangedAt = null
  let energyChangedAt = null
  let eligiblePair = null

  return {
    observe(now, uiSpeakerKeys = [], energeticPipelineIds = []) {
      const nextUi = uiSpeakerKeys.length === 1 ? uiSpeakerKeys[0] : null
      const nextEnergy = energeticPipelineIds.length === 1 ? energeticPipelineIds[0] : null
      const uiChanged = nextUi !== uiKey
      const energyChanged = nextEnergy !== energyId
      if (uiChanged) uiChangedAt = now
      if (energyChanged) energyChangedAt = now
      uiKey = nextUi
      energyId = nextEnergy

      if (!uiKey || !energyId) {
        eligiblePair = null
      } else if (uiChanged || energyChanged) {
        const transitionsAligned = uiChangedAt !== null && energyChangedAt !== null &&
          Math.abs(uiChangedAt - energyChangedAt) <= freshMs
        eligiblePair = transitionsAligned ? `${energyId}\u0000${uiKey}` : null
      }
      const mayLearn = eligiblePair === `${energyId}\u0000${uiKey}` &&
        now - Math.max(uiChangedAt, energyChangedAt) <= freshMs
      return { mayLearn, uiKey, energyId, uiChanged, energyChanged }
    }
  }
}
