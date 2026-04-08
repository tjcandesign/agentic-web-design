import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';

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

function getNestedValue(obj, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function setNestedValue(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined) {
      current[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

const TOOLS = [
  {
    name: "get_current_content",
    description: "Read current content from the site. Use to check what's on the page before making changes.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["index", "process", "site"], description: "Which content file to read" },
        path: { type: "string", description: "Dot-notation path to a specific section, e.g. 'header.title', 'themes.cards[0]'. Omit to get full file." }
      },
      required: ["file"]
    }
  },
  {
    name: "update_content",
    description: "Update a specific content field. Use dot notation for nested paths, [n] for array indices. Examples: 'header.title', 'themes.cards[0].title', 'numbers.stats[1].value'",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["index", "process", "site"] },
        path: { type: "string", description: "Dot-notation path to the field" },
        new_value: { description: "The new value (string, number, object, or array)" }
      },
      required: ["file", "path", "new_value"]
    }
  },
  {
    name: "add_item",
    description: "Add a new item to an array (e.g., add a new quote, theme card, or step)",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["index", "process", "site"] },
        path: { type: "string", description: "Path to the array, e.g. 'quotes.items'" },
        item: { description: "The item object to add" },
        position: { type: "integer", description: "Index to insert at. Omit to append." }
      },
      required: ["file", "path", "item"]
    }
  },
  {
    name: "remove_item",
    description: "Remove an item from an array by index",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["index", "process", "site"] },
        path: { type: "string", description: "Path to the array" },
        index: { type: "integer", description: "0-based index of the item to remove" }
      },
      required: ["file", "path", "index"]
    }
  }
];

const SYSTEM_PROMPT = `You are a website content editor for the "Agentic Web Design" site (agentic-web-design.netlify.app).

You help users update their website content through natural conversation. The site has two pages:
- **index** (index.html): The main conversation article — header, premise, themes, quotes, process steps, comparison table, stats, opportunity section, tech stack
- **process** (process.html): The detailed 10-step system — philosophy layers, tool stack, pipeline flow, 10 process steps with outputs/callouts/prompts, pitfalls, strategy cards

GUIDELINES:
- Always confirm what you're changing before making edits
- Show the old value and new value when making changes
- If the user's request is ambiguous (e.g. "update the quote"), ask which one
- When asked for suggestions (e.g. "make the headline punchier"), propose specific text and ask for approval before applying
- You can update text, add/remove items from arrays (quotes, cards, steps, etc.), and modify any content field
- You CANNOT change visual design, CSS, or layout structure — only content
- HTML entities like &mdash; &ndash; &amp; &times; are used in the content — preserve them
- After making changes, briefly summarize what was updated
- If the user references an element by its data-content-path (e.g. "index.header.title"), use that path directly

CURRENT CONTENT:
`;

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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const body = JSON.parse(event.body);

  // Login
  if (body.action === 'login') {
    if (body.password === process.env.ADMIN_PASSWORD) {
      const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ token }) };
    }
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid password' }) };
  }

  // Auth check
  if (!verifyAuth(event.headers)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (body.action === 'chat') {
    try {
      // Content is provided by the client — no filesystem reads needed
      const content = body.content;
      if (!content || !content.site || !content.index || !content.process) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: 'Missing content in request body. Client must send current content.' })
        };
      }

      const client = new Anthropic();
      const systemPrompt = SYSTEM_PROMPT + JSON.stringify(content, null, 2);
      const messages = body.messages || [];
      const changes = [];

      let response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages
      });

      // Tool use loop
      while (response.stop_reason === 'tool_use') {
        const assistantMsg = { role: 'assistant', content: response.content };
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const { name, input } = block;
          const fileMap = { index: content.index, process: content.process, site: content.site };
          const target = fileMap[input.file];
          let result;

          switch (name) {
            case 'get_current_content': {
              const val = input.path ? getNestedValue(target, input.path) : target;
              result = JSON.stringify(val, null, 2);
              break;
            }
            case 'update_content': {
              const oldVal = getNestedValue(target, input.path);
              setNestedValue(target, input.path, input.new_value);
              changes.push({ type: 'update', file: input.file, path: input.path, old: oldVal, new: input.new_value });
              result = `Updated ${input.file}.${input.path}`;
              break;
            }
            case 'add_item': {
              const arr = getNestedValue(target, input.path);
              if (Array.isArray(arr)) {
                if (input.position !== undefined) arr.splice(input.position, 0, input.item);
                else arr.push(input.item);
                changes.push({ type: 'add', file: input.file, path: input.path, item: input.item });
                result = `Added item to ${input.file}.${input.path}`;
              } else {
                result = `Error: ${input.file}.${input.path} is not an array`;
              }
              break;
            }
            case 'remove_item': {
              const arr2 = getNestedValue(target, input.path);
              if (Array.isArray(arr2) && input.index >= 0 && input.index < arr2.length) {
                const removed = arr2.splice(input.index, 1)[0];
                changes.push({ type: 'remove', file: input.file, path: input.path, removed });
                result = `Removed item at index ${input.index}`;
              } else {
                result = `Error: Invalid index`;
              }
              break;
            }
            default:
              result = `Unknown tool: ${name}`;
          }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }

        messages.push(assistantMsg);
        messages.push({ role: 'user', content: toolResults });

        response = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          tools: TOOLS,
          messages
        });
      }

      const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const finalMessages = [...messages, { role: 'assistant', content: response.content }];

      // Return the (possibly modified) content back to the client
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          reply,
          changes,
          messages: finalMessages,
          content: changes.length > 0 ? content : undefined
        })
      };
    } catch (error) {
      console.error('Chat error:', error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
}
