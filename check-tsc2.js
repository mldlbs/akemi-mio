try {
  require('typescript')
  console.log('typescript module found')
} catch(e) {
  console.log('not found:', e.message)
}
