const { cmd } = require('../command');

cmd({
  pattern: 'echo',
  desc: 'Echoes back the user message',
  react: '🗣️',
  category: 'fun',
  filename: __filename
}, async (conn, m, msg, { reply, args }) => {
  if (!args || args.length === 0) {
    return reply('Please provide a message to echo.');
  }
  const text = args.join(' ');
  await reply(text);
});
