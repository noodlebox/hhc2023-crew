// Autofisher
socket.addEventListener("message", event => {
  const messageType = event.data.substr(0, 2);
  const payload = event.data.substr(2);
  if (messageType !== 'e:') { return; }
  const parsed = JSON.parse(payload);
  const me = parsed[playerData.uid];
  if (!me || !me.onTheLine) { return; }
  console.log(me.onTheLine,"!");
  window.setTimeout(function() {
    socket.send(`reel`);
    window.setTimeout(function() {
      socket.send(`cast`);
    }, 1000)
  }, 1);
});
