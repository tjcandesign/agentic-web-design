import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import ejs from 'ejs';

// With included_files in netlify.toml, templates are bundled relative to process.cwd()
const ROOT = process.cwd();

function verifyAuth(headers) {
  const auth = headers.authorization || headers.Authorization;
  if (!auth) return false;
  const token = auth.replace('Bearer ', '');
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }
  if (!verifyAuth(event.headers)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // Content comes from the client
    const { site, index: indexContent, process: processContent, adminHtml } = body.content || {};
    if (!site || !indexContent || !processContent) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Missing content in request body. Client must send site, index, and process content.' })
      };
    }

    // Read templates from included_files (bundled with the function)
    const templateRoot = join(ROOT, 'templates');

    let indexHtml, processHtml;
    try {
      const indexTplPath = join(templateRoot, 'index.ejs');
      const processTplPath = join(templateRoot, 'process.ejs');

      indexHtml = ejs.render(
        readFileSync(indexTplPath, 'utf8'),
        { content: indexContent, site, page: 'index' },
        { root: templateRoot, filename: indexTplPath }
      );
      processHtml = ejs.render(
        readFileSync(processTplPath, 'utf8'),
        { content: processContent, site, page: 'process' },
        { root: templateRoot, filename: processTplPath }
      );
    } catch (templateErr) {
      console.error('Template render error:', templateErr);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: 'Template render failed: ' + templateErr.message })
      };
    }

    // Collect all files to deploy
    const files = {
      'index.html': indexHtml,
      'process.html': processHtml,
      'content/site.json': JSON.stringify(site, null, 2),
      'content/index.json': JSON.stringify(indexContent, null, 2),
      'content/process.json': JSON.stringify(processContent, null, 2)
    };

    // Include admin HTML if provided, otherwise fetch from live site
    if (adminHtml) {
      files['admin/index.html'] = adminHtml;
    } else {
      try {
        const adminRes = await fetch('https://agentic-web-design.netlify.app/admin/index.html');
        if (adminRes.ok) {
          files['admin/index.html'] = await adminRes.text();
        }
      } catch {
        // Admin page will remain from previous deploy
      }
    }

    // Deploy via Netlify API
    const siteId = process.env.NETLIFY_SITE_ID;
    const apiToken = process.env.NETLIFY_API_TOKEN;

    if (!apiToken) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'NETLIFY_API_TOKEN not configured' }) };
    }

    // Calculate file hashes
    const fileHashes = {};
    for (const [path, content] of Object.entries(files)) {
      fileHashes['/' + path] = createHash('sha1').update(content).digest('hex');
    }

    // Create deploy
    const createRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: fileHashes, draft: false })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Deploy create failed: ${createRes.status} ${errText}`);
    }

    const deploy = await createRes.json();

    // Upload required files
    for (const hash of (deploy.required || [])) {
      const filePath = Object.keys(fileHashes).find(p => fileHashes[p] === hash);
      if (!filePath) continue;
      const content = files[filePath.slice(1)];

      const uploadRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files${filePath}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/octet-stream' },
        body: content
      });

      if (!uploadRes.ok) {
        console.error(`Failed to upload ${filePath}: ${uploadRes.status}`);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, deployId: deploy.id, url: deploy.ssl_url || deploy.url })
    };
  } catch (error) {
    console.error('Deploy error:', error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
}
