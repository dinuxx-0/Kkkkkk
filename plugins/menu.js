const { cmd, commands } = require('../command');

cmd({
  pattern: 'menu',
  desc: 'Show list of available commands and plugins',
  react: '📜',
  category: 'info',
  filename: __filename
}, async (conn, m, msg, { reply }) => {
  try {
    let internalCommands = commands.filter(c => !c.dontAddCommandList);
    let externalPlugins = [];
    const fs = require('fs');
    const path = require('path');
    const pluginsDir = path.join(__dirname);
    const pluginFiles = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js') && f !== 'menu.js');
    for (const file of pluginFiles) {
      try {
        const plugin = require(path.join(pluginsDir, file));
        if (plugin && plugin.pattern) {
          externalPlugins.push(plugin.pattern);
        }
      } catch (e) {
        // ignore errors
      }
    }
    let text = '*Internal Commands:*\n';
    internalCommands.forEach(c => {
      text += `- ${c.pattern} : ${c.desc}\n`;
    });
    text += '\n*External Plugins:*\n';
    externalPlugins.forEach(p => {
      text += `- ${p}\n`;
    });
    await reply(text);
  } catch (error) {
    await reply('Failed to load menu.');
  }
});


cmd({
  pattern: 'enu',
  desc: 'Show list of available commands and plugins',
  react: '📜',
  category: 'info',
  filename: __filename
}, async (conn, m, msg, { reply }) => {
  try {
    let internalCommands = commands.filter(c => !c.dontAddCommandList);
    let externalPlugins = [];
    const fs = require('fs');
    const path = require('path');
    const pluginsDir = path.join(__dirname);
    const pluginFiles = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js') && f !== 'menu.js');
    for (const file of pluginFiles) {
      try {
        const plugin = require(path.join(pluginsDir, file));
        if (plugin && plugin.pattern) {
          externalPlugins.push(plugin.pattern);
        }
      } catch (e) {
        // ignore errors
      }
    }
    let text = '*Internal Commands:*\n';
    internalCommands.forEach(c => {
      text += `- ${c.pattern} : ${c.desc}\n`;
    });
    text += '\n*External Plugins:*\n';
    externalPlugins.forEach(p => {
      text += `- ${p}\n`;
    });
    await reply(text);
  } catch (error) {
    await reply('Failed to load menu.');
  }
});
