import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ejs from 'ejs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const site = JSON.parse(readFileSync(join(__dirname, 'content/site.json'), 'utf8'));
const indexContent = JSON.parse(readFileSync(join(__dirname, 'content/index.json'), 'utf8'));
const processContent = JSON.parse(readFileSync(join(__dirname, 'content/process.json'), 'utf8'));
const convo2Content = JSON.parse(readFileSync(join(__dirname, 'content/conversation-2.json'), 'utf8'));

const tplRoot = join(__dirname, 'templates');

const indexHtml = ejs.render(
  readFileSync(join(tplRoot, 'index.ejs'), 'utf8'),
  { content: indexContent, site, page: 'index' },
  { root: tplRoot, filename: join(tplRoot, 'index.ejs') }
);

const processHtml = ejs.render(
  readFileSync(join(tplRoot, 'process.ejs'), 'utf8'),
  { content: processContent, site, page: 'process' },
  { root: tplRoot, filename: join(tplRoot, 'process.ejs') }
);

const convo2Html = ejs.render(
  readFileSync(join(tplRoot, 'conversation-2.ejs'), 'utf8'),
  { content: convo2Content, site, page: 'conversation-2' },
  { root: tplRoot, filename: join(tplRoot, 'conversation-2.ejs') }
);

writeFileSync(join(__dirname, 'index.html'), indexHtml);
writeFileSync(join(__dirname, 'process.html'), processHtml);
writeFileSync(join(__dirname, 'conversation-2.html'), convo2Html);

console.log('Built index.html, process.html, and conversation-2.html from templates + content');
