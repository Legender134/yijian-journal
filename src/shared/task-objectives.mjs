import { completionChecks } from './task-completion.mjs';

export const isGenericPlaceName = (name) => /^(?:客房|客栈|弟子房|民居|房间|大殿|院落|地牢|山洞)$/.test(name);

// An organisation qualifying a person or a temporary force is not its HQ.
// Preserve real interior destinations such as 主殿 and 方丈室.
export const placeMentionIsQualifier = (name, after) =>
  /^(?:的)?(?:(?:中人|之人|门人|弟子|同门|同道|帮众|教众|众|方丈|住持)(?!房|堂|阁|室)|掌门|门主|师父|师兄|长老|宗师|阵地|军阵|部队)/.test(
    after,
  ) ||
  (/(?:门|教|堡)$/.test(name) && /^主(?!殿|堂|阁|室|峰|楼|厅|院|塔|窟|要|路|门)/.test(after));

// The main process and renderer resolve the same task template against the
// items, money and party of the current reading. Absent values never mean ready.
export function resolveTaskObjectives(template, reading = {}) {
  if (!template) return template;
  const { inventory, money, teamIds } = reading;
  const finishing = completionChecks(template.finishingRequirements, reading);
  const additional = (template.actionRequirements || []).filter(
    (requirement) =>
      !finishing.some(
        (row) =>
          row.type === requirement.type &&
          (row.type === 'Money' ||
            (row.type === 'TeamMember' && (requirement.ids || [requirement.id]).includes(row.id))),
      ),
  );
  const requirements = [
    ...finishing.filter((row) => row.type !== 'Item'),
    ...additional.map((requirement) => {
      if (requirement.type === 'Money')
        return {
          status: !Number.isFinite(money) ? 'unknown' : money < requirement.value ? 'unmet' : 'met',
          hint:
            Number.isFinite(money) && money < requirement.value
              ? `还需 ${(requirement.value - money).toLocaleString('zh-CN')} 文`
              : `需 ${requirement.value.toLocaleString('zh-CN')} 文`,
        };
      if (requirement.type === 'TeamMember')
        return {
          status: !Array.isArray(teamIds)
            ? 'unknown'
            : (requirement.ids || [requirement.id]).some((id) => teamIds.includes(id))
              ? 'met'
              : 'unmet',
          hint: requirement.hint || `需${requirement.name}在队`,
          partyName: requirement.hint ? '' : requirement.name,
        };
      return { status: 'unknown', hint: requirement.name || '完成条件待确认' };
    }),
  ];
  if (finishing.length) template = { ...template, completionChecks: finishing };
  const pending = requirements.filter((requirement) => requirement.status !== 'met');
  const party = pending
    .filter((requirement) => requirement.partyName)
    .map((requirement) => requirement.partyName);
  const preparation = [
    ...(party.length ? [`需${party.join('、')}在队`] : []),
    ...pending.filter((requirement) => !requirement.partyName).map((requirement) => requirement.hint),
  ].join('；');
  if (!template.materialGate && !pending.length && template.alternativeHandIn) {
    const { recipientIds, action } = template.alternativeHandIn;
    const recipients = template.people.filter((person) =>
      (person.ids || []).some((id) => recipientIds.includes(id)),
    );
    if (recipients.length)
      return {
        ...template,
        nextAction: `向${recipients.map((person) => person.name).join('、')}${action}`,
        people: recipients,
        // An acquisition clue is no longer the current destination. Only an
        // independently bound turn-in place can survive the hand-in switch.
        places: template.places.filter((place) => place.purpose === 'turn-in'),
      };
  }
  if (!template.materialGate)
    return pending.length
      ? {
          ...template,
          actionState: pending.some((requirement) => requirement.status === 'unmet') ? 'missing' : 'unknown',
          conditionHint: preparation,
          nextAction: [
            String(template.nextAction || template.instruction || '').replace(/[。；]\s*$/, ''),
            preparation,
          ]
            .filter(Boolean)
            .join('；'),
          people: template.people.map((person) => ({
            ...person,
            role: `条件满足后${person.role || '交互'}`,
          })),
          places: template.places.map((place) => ({ ...place, conditionHint: preparation })),
        }
      : template;
  const {
    materials,
    collecting,
    collectionPlaces,
    recipientIds = [],
    action = '交付',
    collectionAction,
    readyAction,
  } = template.materialGate;
  const known = Array.isArray(inventory);
  const totals = new Map();
  for (const row of known ? inventory : [])
    if (Number.isSafeInteger(row.count) && row.count >= 0)
      totals.set(row.id, (totals.get(row.id) || 0) + row.count);
  const missing = materials.filter((m) => !known || (totals.get(m.id) || 0) < m.count);
  const materialState =
    (known && missing.length) || pending.some((r) => r.status === 'unmet')
      ? 'missing'
      : !known || pending.length
        ? 'unknown'
        : 'ready';
  const baseAction =
    materialState === 'missing'
      ? known && !missing.length
        ? ''
        : collectionAction || '先备齐所需材料'
      : known && !missing.length
        ? ''
        : action === '交付'
          ? '集齐材料后交付'
          : '备齐材料后继续任务';
  const isRecipient = (person) => (person.ids || []).some((id) => recipientIds.includes(id));
  const recipients = template.people.filter(isRecipient);
  const handIn = template.places
    .filter((place) => place.purpose === 'turn-in' || !collecting)
    .map((place) => ({ ...place, purpose: 'turn-in', action, conditionHint: preparation }));
  const sources = collectionPlaces
    .map((place) => ({
      ...place,
      materialIds: place.materialIds.filter((id) => missing.some((m) => m.id === id)),
    }))
    .filter((place) => place.materialIds.length);
  const names = recipients.map((person) => person.name).join('、');
  return {
    ...template,
    materialState,
    conditionHint: preparation,
    nextAction:
      materialState === 'ready'
        ? names
          ? action === '交付'
            ? `向${names}交付`
            : `找${names}继续任务`
          : readyAction ||
            (handIn.length
              ? `前往${handIn.map((place) => place.name).join('、')}${action}`
              : '材料已齐，继续任务')
        : [baseAction, preparation].filter(Boolean).join('；'),
    people:
      materialState === 'ready'
        ? template.people
        : materialState === 'unknown'
          ? template.people.map((person) =>
              isRecipient(person)
                ? {
                    ...person,
                    role: pending.length
                      ? `条件满足后${action}`
                      : action === '交付'
                        ? '集齐后交付'
                        : '备齐后交谈',
                  }
                : person,
            )
          : template.people.filter((person) => !isRecipient(person)),
    places:
      materialState === 'ready'
        ? handIn
        : materialState === 'unknown'
          ? [...sources, ...handIn.map((place) => ({ ...place, purpose: 'conditional-turn-in' }))]
          : sources,
    purpose: materialState === 'ready' ? 'turn-in' : 'objective',
  };
}

export const allObjectivePlaces = (template) => [
  ...(template?.places || []),
  ...(template?.deferredPlaces || []),
  ...(template?.materialGate?.collectionPlaces || []),
];
