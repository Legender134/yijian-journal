// These are literal mentions in the game's task text, not a claim that a
// person currently occupies a location or that a task can already be taken.
export function taskMentions(index, task) {
  const text = task.description || task.name || '';
  const people = index.entries.filter(
    (p) =>
      p.kind === '人物' &&
      p.name.length >= 2 &&
      (text.includes(p.name) ||
        (p.name.includes('-') &&
          p.name.split('-').at(-1).length >= 2 &&
          text.includes(p.name.split('-').at(-1)))),
  );
  const places = index.world.maps.filter((m) => text.includes(m.name));
  const aliases = [];
  for (const alias of index.world.placeAliases || []) {
    const mention = alias.mentions.find((phrase) => text.includes(phrase));
    if (!mention || places.some((m) => m.name === alias.name)) continue;
    const choices = index.world.maps.filter((m) => m.name === alias.name);
    if (choices.length) aliases.push({ mention, name: alias.name, choices });
  }
  const groups = new Map();
  for (const place of places) {
    if (!groups.has(place.name)) groups.set(place.name, []);
    groups.get(place.name).push(place);
  }
  return {
    people,
    places: [...groups].map(([name, choices]) => ({ name, mention: name, choices })),
    aliases,
  };
}
