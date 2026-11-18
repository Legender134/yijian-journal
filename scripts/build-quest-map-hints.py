import collections
import hashlib
import json
from pathlib import Path

base = Path(__file__).resolve().parent.parent
research = base / '.test-data/source-correctness-20261025'
source = research / 'map-quest-original-nodes-20261107-local/original-groups.jsonl'
rows_file = research / 'quest-structured-index-20261107-independent/quest-rows.jsonl'
world = json.loads((base / 'src/data/world-index.json').read_text(encoding='utf-8'))
maps = collections.Counter(row['key'] for row in world['maps'])
published = {row['gameId']: row for row in world['quests']}
# These action fields were individually read from the cached map assets and
# matched against asset receipts, actor names, action types and IDs.
verified_action_zero_lines = {59, 60, 104, 105, 106, 107, 108, 109, 110, 111, 112, 120, 200, 201, 202, 203, 219, 223, 247, 261, 268, 273, 287, 290, 296, 300, 305, 309, 313, 357, 363, 381, 383, 426, 442, 478, 479, 548, 666, 674, 688, 691, 693, 694, 695, 696, 702, 731, 732, 733, 773, 805, 806, 817, 818, 851, 879, 896, 956, 957, 1056, 1057, 1058, 1059, 1060, 1061, 1062, 1063, 1064, 1152, 1162, 1191}
verified_action_source = hashlib.sha256(source.read_bytes()).hexdigest() == '948cc3a9a8c040907f44d1d49adf696c188fa5fba67f5b18e7d3bcc0ace33651'
rows = collections.defaultdict(list)
for line in rows_file.open(encoding='utf-8'):
    row = json.loads(line)
    rows[row['identity']['questId']].append(row)

def original_triple(node, allow_positive_zero=False):
    fields = {value['Name']: value.get('Value') for value in node.get('Value', [])}
    kind = str(fields.get('Type', '')).split('::')[-1]
    ident, number = fields.get('Id'), fields.get('Num')
    nums = [value for value in node.get('Value', []) if value.get('Name') == 'Num']
    # UAssetAPI serializes positive Single zero as "+0"; map nodes were
    # independently read from the cached level assets to confirm the bits.
    if (allow_positive_zero and number == '+0' and len(nums) == 1
            and nums[0].get('$type') == 'UAssetAPI.PropertyTypes.Objects.FloatPropertyData, UAssetAPI'):
        number = 0.0
    if not kind or not isinstance(ident, int) or not isinstance(number, (int, float)):
        return None
    return {'type': kind, 'id': ident, 'value': number}

def owner(ident):
    seen = set()
    while ident not in seen:
        seen.add(ident)
        if ident in published:
            return ident
        found = rows.get(ident, [])
        if len(found) != 1:
            return None
        ident = found[0]['fields']['OwnerQuestId']['value']
    return None

events = []
stats = collections.Counter()
eligible = {}
for line in source.open(encoding='utf-8'):
    stats['input'] += 1
    raw = json.loads(line)
    key = Path(raw['member']).stem
    matched = raw['matchedQuestRows']
    action = original_triple(raw['originalAction'], allow_positive_zero=(
        verified_action_source and stats['input'] in verified_action_zero_lines))
    if not action or action['type'] not in ('JumpStep', 'CQuestStep', 'RQuest') or len(matched) != 1:
        stats['ambiguous_action_or_identity'] += 1
        continue
    entries = rows.get(action['id'], [])
    if len(entries) != 1 or entries[0]['identity']['sourceOrdinal'] != matched[0]['ordinal'] or entries[0]['identity']['rawRowSha256'] != matched[0]['sha256']:
        stats['ambiguous_action_or_identity'] += 1
        continue
    target = owner(action['id'])
    if target is None:
        stats['unpublished_quest'] += 1
        continue
    group_fields = {v['Name']: v for v in raw['originalGroup']['Value']}
    requirements = group_fields.get('Requirements', {}).get('Value')
    if not isinstance(requirements, list):
        stats['unresolved_conditions'] += 1
        continue
    conditions = [original_triple(node, allow_positive_zero=True) for node in requirements]
    if any(c is None for c in conditions):
        stats['unresolved_conditions'] += 1
        continue
    event = {'questId': target, 'stepId': action['id'], 'mapKey': key, 'action': action, 'conditions': conditions}
    eligible[stats['input']] = (raw, event)
    if maps[key] == 1:
        events.append(event)
        stats['published'] += 1
    else:
        stats['unmapped_map'] += 1

candidates = []
candidate_file = research / 'quest-map-streaming-candidates-20261107-local.jsonl'
for line in candidate_file.open(encoding='utf-8'):
    candidate = json.loads(line)
    stats['streaming_input'] += 1
    match = eligible.get(candidate['originalGroupLine'])
    if not match or match[0]['member'] != candidate['member'] or maps[candidate['mapKey']] != 1:
        stats['streaming_excluded'] += 1
        continue
    raw, event = match
    candidates.append({**event, 'mapKey': candidate['mapKey'],
        'association': 'streaming-parent-candidate', 'sourceMember': raw['member'],
        'sourceGroupPointer': raw['groupPointer'], 'sourceActionPointer': raw['actionPointer'],
        'sourceDecodedSha256': raw['decodedSha256'], 'originalGroupLine': candidate['originalGroupLine'],
        'sourceFiles': candidate['sourceFiles'], 'streamingEvidence': candidate['evidence']})
    stats['streaming_published'] += 1

out = {'schema': 1, 'build': world['build'], 'events': events, 'streamingParentCandidates': candidates}
(base / 'src/data/quest-map-hints.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
print(json.dumps(dict(stats), ensure_ascii=False))
