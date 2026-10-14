'use strict';
// Plain labels identify the exact planned gift in action lists and user history.
function giftItemLabel(item) {
  return item ? (item.quality ? `${item.name}（${item.quality}色品质）` : item.name) : '';
}
function giftPersonLabel(person, entries) {
  if (!person) return '';
  const sameName = entries.filter((row) => row.kind === '人物' && row.name === person.name);
  return sameName.length > 1
    ? `${person.name}（资料 ${sameName.findIndex((row) => row.id === person.id) + 1}/${sameName.length}）`
    : person.name;
}
module.exports = { giftItemLabel, giftPersonLabel };
