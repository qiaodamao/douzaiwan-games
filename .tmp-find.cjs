const fs = require('fs');
const s = fs.readFileSync('d:/网站相关/qiaodamao/douzaiwan-games/list/tetris/js/app-1.0.1.js', 'utf8');
// Full module 269: extract around 292904, going back ~900 chars
console.log(s.slice(291900, 293400));
