async function updateCheck() {
  if (process.env.LOOM_NO_UPDATE_CHECK) return;
  return;
}

module.exports = { updateCheck };