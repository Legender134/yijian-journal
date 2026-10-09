// Operator precedence and the separation of parsing from matching are adapted
// from Destiny Item Manager, src/app/search/query-parser.ts, commit
// d7c02e5cf9ba19e750bc626f497a7a069be23b08. Copyright (c) 2018 Destiny Item
// Manager, MIT. See src/third-party/DIM-LICENSE.txt and THIRD_PARTY_NOTICES.md.
const operators = {
  implicit_and: { precedence: 1, op: 'and' },
  or: { precedence: 2, op: 'or' },
  and: { precedence: 3, op: 'and' },
};
export const searchFilterFields = [
  {
    name: '种类',
    key: 'kind',
    aliases: ['kind'],
    description: '完整匹配资料或个人记录的种类',
    examples: ['物品', '武学', '人物', '配方', '任务', '地点', '目标', '计划', '行动', '记录', '笔记'],
  },
  {
    name: '类型',
    key: 'type',
    aliases: ['type'],
    description: '包含某种物品、武学或资料类型',
    examples: ['丹药', '剑法'],
  },
  {
    name: '品质',
    key: 'quality',
    aliases: ['quality'],
    description: '完整匹配图鉴品质；配方按产物品质核对',
    examples: ['白', '绿', '蓝', '金', '暗金', '红'],
  },
  {
    name: '名称',
    key: 'name',
    aliases: ['name'],
    description: '名称或标题包含这段文字',
    examples: ['卫霍', '铁锭'],
  },
  {
    name: '地点',
    key: 'location',
    aliases: ['location'],
    description: '资料或记录的地点线索包含这段文字',
    examples: ['梧桐村'],
  },
  {
    name: '状态',
    key: 'status',
    aliases: ['status'],
    description: '完整匹配目标或已保存游戏任务的状态；游戏状态来自存档',
    examples: ['未完成', '已完成', '未开始', '进行中', '已失败', '未接取', '待核对'],
  },
  { name: '标签', key: 'tags', aliases: ['tag'], description: '标签包含这段文字', examples: ['朋友'] },
];
const fields = Object.fromEntries(
  searchFilterFields.flatMap((field) => [field.name, ...field.aliases].map((name) => [name, field.key])),
);
function lex(query) {
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) {
      i++;
      continue;
    }
    if ('()-'.includes(query[i])) {
      tokens.push({ type: query[i++] });
      continue;
    }
    let value = '',
      quoted = false,
      filterColon = -1;
    while (i < query.length && !/\s|[()]/.test(query[i])) {
      const c = query[i++];
      if (c === '"' || c === "'") {
        quoted = true;
        let closed = false;
        while (i < query.length) {
          const next = query[i++];
          if (next === c) {
            closed = true;
            break;
          }
          if (next === '\\' && i < query.length) value += query[i++];
          else value += next;
        }
        if (!closed) throw Error('引号尚未闭合，请补上引号或直接输入关键词');
      } else {
        if ((c === ':' || c === '：') && filterColon < 0) filterColon = value.length;
        value += c;
      }
    }
    if (!value) throw Error('请输入关键词');
    const word = value.toLowerCase();
    const boolean = !quoted && { and: 'and', or: 'or', not: '-', 且: 'and', 或: 'or', 非: '-' }[word];
    if (boolean) tokens.push({ type: boolean });
    else {
      const colon = filterColon;
      if (colon >= 0) {
        const field = fields[value.slice(0, colon).toLowerCase()];
        if (!field) throw Error('筛选名称未识别，可用：种类、类型、品质、名称、地点、状态、标签');
        const term = value.slice(colon + 1);
        if (!term) throw Error('请在冒号后填写筛选内容');
        tokens.push({ type: 'term', field, value: term.toLowerCase() });
      } else tokens.push({ type: 'term', value: word });
    }
  }
  return tokens;
}

// Term replacement and caret preservation follow DIM's autocomplete.ts at the
// same pinned MIT commit as the parser. Local fields and values are our own.
function completionTerm(query, caret) {
  caret = Math.max(0, Math.min(query.length, caret));
  let start = 0,
    quote = '',
    escaped = false;
  for (let i = 0; i < caret; i++) {
    const char = query[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s|[()]/.test(char)) start = i + 1;
  }
  let end = caret;
  for (; end < query.length; end++) {
    const char = query[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s|[()]/.test(char)) break;
  }
  return { start, end, typed: query.slice(start, caret) };
}
function filterValue(value) {
  return /\s|[():："'\\]/.test(value) ? JSON.stringify(value) : value;
}
function replaceCompletion(query, span, term, complete) {
  const suffix = query.slice(span.end);
  const separator = complete && (!suffix || !/^[\s)]/.test(suffix)) ? ' ' : '';
  const next = query.slice(0, span.start) + term + separator + suffix;
  if (next.length > 200) return null;
  return { query: next, caret: span.start + term.length + separator.length };
}
export function searchFilterSuggestions(query, caret = query.length, values = {}) {
  const span = completionTerm(query, caret);
  const negated = span.typed.startsWith('-'),
    typed = negated ? span.typed.slice(1) : span.typed;
  if (!typed || typed.startsWith('"') || typed.startsWith("'")) return [];
  const colon = typed.search(/[:：]/);
  if (colon < 0) {
    return searchFilterFields
      .filter((field) =>
        [field.name, ...field.aliases].some((name) => name.toLowerCase().startsWith(typed.toLowerCase())),
      )
      .map((field) => ({
        label: field.name + ':',
        description: field.description,
        ...replaceCompletion(query, span, (negated ? '-' : '') + field.name + ':', false),
      }))
      .filter((row) => row.query !== undefined);
  }
  const name = typed.slice(0, colon),
    field = searchFilterFields.find((field) => [field.name, ...field.aliases].includes(name.toLowerCase()));
  if (!field) return [];
  let prefix = typed.slice(colon + 1);
  if (prefix.startsWith('"') || prefix.startsWith("'")) prefix = prefix.slice(1).replace(/["']$/, '');
  const candidates = values[field.key] || field.examples;
  return [...new Set(candidates)]
    .filter(
      (value) =>
        typeof value === 'string' &&
        value.toLowerCase().startsWith(prefix.toLowerCase()) &&
        value.toLowerCase() !== prefix.toLowerCase(),
    )
    .slice(0, 8)
    .map((value) => ({
      label: field.name + ':' + value,
      description: field.description,
      ...replaceCompletion(
        query,
        span,
        (negated ? '-' : '') + name + typed[colon] + filterValue(value),
        true,
      ),
    }))
    .filter((row) => row.query !== undefined);
}
export function insertSearchFilter(query, caret, term) {
  const span = completionTerm(query, caret),
    current = span.typed.replace(/^-/, '').split(/[:：]/)[0];
  const requested = term.split(/[:：]/)[0];
  const field = searchFilterFields.find((field) => [field.name, ...field.aliases].includes(requested));
  if (
    field &&
    [field.name, ...field.aliases].includes(current.toLowerCase()) &&
    !span.typed.startsWith('"') &&
    !span.typed.startsWith("'")
  )
    return replaceCompletion(
      query,
      span,
      (span.typed.startsWith('-') ? '-' : '') + term,
      !term.endsWith(':'),
    );
  const before = query.slice(0, caret),
    after = query.slice(caret);
  const lead = before && !/[\s(]$/.test(before) ? ' ' : '',
    tail = !term.endsWith(':') && (!after || !/^[\s)]/.test(after)) ? ' ' : '';
  const next = before + lead + term + tail + after;
  return next.length <= 200
    ? { query: next, caret: before.length + lead.length + term.length + tail.length }
    : null;
}
export function parseSearchQuery(query) {
  if (typeof query !== 'string' || query.length > 200) throw Error('搜索内容须在 200 字以内');
  const tokens = lex(query),
    peek = () => tokens[cursor];
  let cursor = 0,
    depth = 0;
  function atom() {
    const token = tokens[cursor++];
    if (!token) throw Error('请补充搜索关键词');
    if (++depth > 40) throw Error('搜索括号过多，请简化条件');
    let result;
    if (token.type === '-') result = { op: 'not', operand: atom() };
    else if (token.type === '(') {
      result = parse(0);
      if (tokens[cursor++]?.type !== ')') throw Error('搜索括号尚未配对');
    } else if (token.type === 'term') result = { op: 'term', ...token };
    else throw Error('搜索条件不完整，请补充关键词');
    depth--;
    return result;
  }
  function parse(minimum) {
    let left = atom();
    while (peek() && peek().type !== ')') {
      const explicit = operators[peek().type];
      const operator = explicit || operators.implicit_and;
      if (operator.precedence < minimum) break;
      if (explicit) cursor++;
      const right = parse(operator.precedence + 1);
      left = { op: operator.op, left, right };
    }
    return left;
  }
  if (!tokens.length) return null;
  const result = parse(0);
  if (cursor !== tokens.length) throw Error('搜索括号尚未配对');
  return result;
}
function flatten(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(flatten).join(' ');
  return '';
}
export function searchableText(entry) {
  return [
    'name',
    'title',
    'description',
    'detail',
    'hint',
    'location',
    'kind',
    'type',
    'quality',
    'hobbies',
    'tags',
    'materials',
    'results',
    'requirements',
  ]
    .map((key) => flatten(entry[key]))
    .join(' ')
    .toLowerCase();
}
function match(node, entry) {
  if (!node) return true;
  if (node.op === 'and') return match(node.left, entry) && match(node.right, entry);
  if (node.op === 'or') return match(node.left, entry) || match(node.right, entry);
  if (node.op === 'not') return !match(node.operand, entry);
  if (!node.field) return searchableText(entry).includes(node.value);
  const value = flatten(node.field === 'name' ? entry.name || entry.title : entry[node.field]).toLowerCase();
  return node.field === 'kind' || node.field === 'quality' || node.field === 'status'
    ? value === node.value
    : value.includes(node.value);
}
export function compileSearch(query) {
  const tree = parseSearchQuery(query);
  return (entry) => match(tree, entry);
}

// Rank the user's positive name intent after parsing filters. Only a matching
// OR branch may improve relevance; negated words and other facets are not names.
export function compareSearchTitles(query) {
  const tree = parseSearchQuery(query);
  function phrase(node) {
    if (!node || node.op === 'not') return [];
    if (node.op === 'or') return null;
    if (node.op === 'term') return !node.field || node.field === 'name' ? [node.value] : [];
    const left = phrase(node.left),
      right = phrase(node.right);
    return left && right ? [...left, ...right] : null;
  }
  const terms = phrase(tree),
    fullName = terms?.join(' ');
  function exact(node, entry, title) {
    if (!node || node.op === 'not') return 0;
    if (node.op === 'term') return Number((!node.field || node.field === 'name') && title === node.value);
    return Math.max(
      node.op !== 'or' || match(node.left, entry) ? exact(node.left, entry, title) : 0,
      node.op !== 'or' || match(node.right, entry) ? exact(node.right, entry, title) : 0,
    );
  }
  function rank(entry) {
    const title = String(entry.title || entry.name || '')
      .trim()
      .toLowerCase();
    return fullName && title === fullName ? 2 : exact(tree, entry, title);
  }
  return (a, b) => rank(b) - rank(a);
}
