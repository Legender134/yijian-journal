import { entityCatalog } from './entity-catalog.js';

// These are literal mentions in the game's task text, not a claim that a
// person currently occupies a location or that a task can already be taken.
// Keep the same occurrence-based rule as core/journey-plan.cjs.
function literalPlaceMentions(text, phrases) {
  const matches = [];
  for (const phrase of new Set(phrases)) {
    if (phrase.length < 2) continue;
    for (let start = text.indexOf(phrase); start !== -1; start = text.indexOf(phrase, start + 1))
      matches.push({ phrase, start, end: start + phrase.length });
  }
  return new Set(
    matches
      .filter(
        (match) =>
          !matches.some(
            (other) =>
              other.phrase.length > match.phrase.length &&
              other.start <= match.start &&
              other.end >= match.end,
          ),
      )
      .map((match) => match.phrase),
  );
}

export function taskMentions(index, task) {
  const text = task.description || task.name || '';
  const people = entityCatalog(index)
    .personMentions(text)
    .map((row) => row.entity);
  const names = new Set(index.world.maps.map((m) => m.name));
  const mentions = literalPlaceMentions(text, [
    ...names,
    ...(index.world.placeAliases || [])
      .filter((alias) => names.has(alias.name))
      .flatMap((alias) => alias.mentions),
  ]);
  const places = index.world.maps.filter((m) => mentions.has(m.name));
  const aliases = [];
  for (const alias of index.world.placeAliases || []) {
    const mention = alias.mentions.find((phrase) => mentions.has(phrase));
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
    places: [...groups].map(([name, variants]) => ({
      name,
      mention: name,
      choices: [
        ...new Map(
          [
            ...variants,
            ...(index.world.placeAliases || [])
              .filter((alias) => alias.ambiguousMentions?.includes(name))
              .flatMap((alias) => index.world.maps.filter((m) => m.name === alias.name)),
          ].map((place) => [place.key, place]),
        ).values(),
      ],
    })),
    aliases,
  };
}
