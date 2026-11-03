export const panelStyles = {
  position: 'fixed', zIndex: '2147483647', width: '310px', background: '#202124',
  color: '#fff', padding: '11px', borderRadius: '14px', fontFamily: 'Arial, sans-serif',
  fontSize: '12px', boxShadow: '0 8px 28px rgba(0,0,0,.5)', userSelect: 'none', boxSizing: 'border-box'
}

export const buttonStyles = {
  background: '#303134', color: '#fff', border: '1px solid #5f6368',
  borderRadius: '7px', padding: '5px 8px', cursor: 'pointer', fontSize: '11px', lineHeight: '14px'
}

export const headerStyles = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '8px'
}

export const levelTrackStyles = {
  position: 'relative', height: '3px', borderRadius: '999px', background: '#3c4043', margin: '1px 2px 5px'
}

export const levelFillStyles = {
  position: 'absolute', left: '0', top: '0', height: '100%', width: '0%', borderRadius: '999px',
  background: '#8ab4f8', opacity: '.9'
}

export const levelTickStyles = {
  position: 'absolute', top: '-3px', left: '0%', width: '2px', height: '9px', marginLeft: '-1px',
  borderRadius: '1px', background: '#e8eaed', display: 'none'
}
