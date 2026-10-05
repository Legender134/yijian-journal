'use strict';
const DEFAULTS = { save: 'Control+Alt+S', history: 'Control+Alt+H' };
function normalize(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 40) throw Error('快捷键无效');
  const parts = value
    .trim()
    .replace(/^Ctrl\+/i, 'Control+')
    .split('+');
  const key = parts.pop()?.toUpperCase();
  const modifiers = parts.map((p) => p.toLowerCase()).sort();
  if (
    !/^(?:[A-Z]|F[1-9]|F1[0-2])$/.test(key || '') ||
    !['alt,control', 'alt,control,shift'].includes(modifiers.join(','))
  )
    throw Error('请使用 Ctrl+Alt+字母或 F1–F12，可加 Shift；留空可停用');
  const result = 'Control+Alt+' + (modifiers.includes('shift') ? 'Shift+' : '') + key;
  if (result === 'Control+Alt+J') throw Error('Ctrl+Alt+J 已用于随行小窗');
  return result;
}
function validate(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'history,save')
    throw Error('快捷键设置无效');
  const next = { save: normalize(value.save), history: normalize(value.history) };
  if (next.save && next.save === next.history) throw Error('保存和历史快捷键不能相同');
  return next;
}
class Shortcuts {
  constructor(registry, callbacks, enabled = true) {
    this.registry = registry;
    this.callbacks = callbacks;
    this.enabled = enabled;
    this.active = {};
    this.errors = {};
  }
  start(values = DEFAULTS) {
    const next = validate(values);
    for (const [action, key] of Object.entries(next)) {
      if (!key || !this.enabled) continue;
      if (this.registry.register(key, this.callbacks[action])) this.active[action] = key;
      else this.errors[action] = key + ' 被其他程序占用';
    }
  }
  configure(values, persist) {
    const next = validate(values),
      reserved = [];
    try {
      // Reserve the replacement keys first, preserving working bindings on failure.
      if (this.enabled)
        for (const [action, key] of Object.entries(next)) {
          if (!key || key === this.active[action]) continue;
          if (
            Object.values(this.active).includes(key) ||
            !this.registry.register(key, this.callbacks[action])
          )
            throw Error(key + ' 已被占用，请更换快捷键或先停用原绑定');
          reserved.push(key);
        }
      persist(next);
    } catch (error) {
      for (const key of reserved) this.registry.unregister(key);
      throw error;
    }
    for (const [action, key] of Object.entries(this.active))
      if (next[action] !== key) this.registry.unregister(key);
    this.active = this.enabled ? Object.fromEntries(Object.entries(next).filter(([, key]) => key)) : {};
    this.errors = {};
    return next;
  }
  summary(values = DEFAULTS) {
    return { values, active: { ...this.active }, errors: { ...this.errors } };
  }
}
module.exports = { Shortcuts, DEFAULTS, validate, normalize };
