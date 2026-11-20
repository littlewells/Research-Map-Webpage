"""Persist the current map; retain undo and redo only in this process."""
import hashlib
import json
import math
import re
import library_manager

COLORS = ('blue', 'indigo', 'slate', 'violet')
STYLES = ('default', 'soft', 'outline', 'emphasis')
ICONS = ('', '★', '◆', '✓', '?', '!')
TYPOGRAPHY_KEYS = tuple(prefix+'_'+key for prefix in ('title', 'remark') for key in ('size', 'bold', 'italic', 'underline', 'thickness'))
_history = None


def clear_history():
    global _history
    _history = None


def history_for(revision, fingerprint):
    if _history and _history[:2] == (revision, fingerprint):
        return _history[2:]
    return [], 0


def typography(value):
    if not isinstance(value, dict) or any(k not in TYPOGRAPHY_KEYS for k in value):
        raise ValueError('文字样式格式无效')
    result = {}
    for key, setting in value.items():
        if key.endswith('_size'):
            maximum = 72 if key.startswith('title') else 48
            if type(setting) is not int or not 10 <= setting <= maximum:
                raise ValueError('标题字号应为10–72，备注字号应为10–48的整数')
        elif key.endswith('_thickness'):
            if type(setting) is not int or not 0 <= setting <= 100:
                raise ValueError('文字增粗强度应为0–100的整数')
        elif type(setting) is not bool:
            raise ValueError('加粗、斜体和下划线设置必须为布尔值')
        result[key] = setting
    return result


def initialize(c):
    c.executescript('''
CREATE TABLE IF NOT EXISTS map_node_details(
 node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
 hidden INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS map_editor_document(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
 annotations TEXT NOT NULL DEFAULT '[]', history TEXT NOT NULL DEFAULT '[]',
 cursor INTEGER NOT NULL DEFAULT 0, signature TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO map_editor_document(id) VALUES(1);
''')


def snapshot(c):
    result = []
    for r in c.execute('''SELECT n.id,n.parent_id,n.name,n.keywords,n.position,d.details
      FROM nodes n LEFT JOIN map_node_details d ON d.node_id=n.id
      WHERE coalesce(d.hidden,0)=0 ORDER BY n.position,n.name,n.id'''):
        n = dict(r)
        details = json.loads(n.pop('details') or '{}')
        n.update({k: details.get(k, '') for k in ('remark', 'notes', 'style', 'color', 'icon', 'link')})
        # Keep implicit defaults absent so existing document fingerprints/history stay valid.
        n.update({k: details[k] for k in ('text_align', 'remark_align') if details.get(k) in ('left', 'center', 'right')})
        n.update({k: details[k] for k in ('typography', 'global_typography') if details.get(k)})
        result.append(n)
    row = c.execute('SELECT * FROM map_editor_document WHERE id=1').fetchone()
    return dict(nodes=result, annotations=json.loads(row['annotations']))


def signature(doc):
    return hashlib.sha256(json.dumps(doc, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def document(c):
    doc = snapshot(c)
    row = c.execute('SELECT * FROM map_editor_document WHERE id=1').fetchone()
    sig = signature(doc)
    history, cursor = history_for(row['revision'], sig)
    return dict(**doc, revision=row['revision'], fingerprint=sig,
                can_undo=cursor > 0, can_redo=cursor < len(history))


def text(value, maximum, field, empty=True):
    if not isinstance(value, str):
        raise ValueError(field + '必须是文字')
    value = value.strip()
    if len(value) > maximum or (not empty and not value):
        raise ValueError(field + '不能为空或超出长度限制（' + str(maximum) + '字）')
    return value


def validate(raw, root):
    if not isinstance(raw, dict) or not isinstance(raw.get('nodes'), list):
        raise ValueError('导图数据格式不正确')
    if not 1 <= len(raw['nodes']) <= 1000:
        raise ValueError('导图需要保留根节点，最多支持1000个节点')
    result, ids = [], set()
    for item in raw['nodes']:
        if not isinstance(item, dict):
            raise ValueError('节点格式不正确')
        nid = text(item.get('id'), 80, '节点标识', False)
        if not re.fullmatch(r'[\w-]+', nid) or nid in ids:
            raise ValueError('节点标识重复或无效')
        ids.add(nid)
        parent = item.get('parent_id')
        if parent is not None and not isinstance(parent, str):
            raise ValueError('父节点标识无效')
        style, color, icon = item.get('style', ''), item.get('color', ''), item.get('icon', '')
        if style not in ('',) + STYLES or color not in ('',) + COLORS or icon not in ICONS:
            raise ValueError('节点样式无效')
        link = text(item.get('link', ''), 2000, '节点链接')
        if link and (not re.match(r'^https?://[^\s]+$', link, re.I) or '\\' in link):
            raise ValueError('节点链接需要使用完整的 http 或 https 地址')
        result.append(dict(id=nid, parent_id=parent, name=text(item.get('name'), 160, '方向名称', False),
                           keywords=text(item.get('keywords', ''), 3000, '关键词'),
                           position=0, remark=text(item.get('remark', ''), 500, '简短备注'),
                           notes=text(item.get('notes', ''), 20000, '详细笔记'),
                           style=style, color=color, icon=icon, link=link))
        for key in ('text_align', 'remark_align'):
            value = item.get(key, '')
            if value not in ('', 'left', 'center', 'right'):
                raise ValueError('文字对齐方式无效')
            if value:
                result[-1][key] = value
        for key in ('typography', 'global_typography'):
            if key in item:
                values = typography(item[key])
                if values:
                    result[-1][key] = values
    roots = [n['id'] for n in result if n['parent_id'] is None]
    if roots != [root]:
        raise ValueError('根节点必须保留，并且只能有一个根节点')
    lookup = {n['id']: n for n in result}
    order = {}
    for n in result:
        if n['parent_id'] is not None and n['parent_id'] not in ids:
            raise ValueError('所属方向不存在')
        seen, current = set(), n
        while current['parent_id'] is not None:
            if current['id'] in seen:
                raise ValueError('不能将节点移动到自身或后代中')
            seen.add(current['id'])
            current = lookup[current['parent_id']]
            if len(seen) > 80:
                raise ValueError('导图最多支持80层')
        parent = n['parent_id']
        n['position'] = order.get(parent, 0)
        order[parent] = n['position'] + 1
    annotations = raw.get('annotations', [])
    if not isinstance(annotations, list) or len(annotations) > 1000:
        raise ValueError('概要、联系与分组数量超出限制')
    clean, annotation_ids = [], set()
    for item in annotations:
        if not isinstance(item, dict):
            raise ValueError('导图标注格式不正确')
        aid = text(item.get('id'), 80, '标注标识', False)
        if not re.fullmatch(r'[\w-]+', aid) or aid in annotation_ids:
            raise ValueError('标注标识重复或无效')
        annotation_ids.add(aid)
        kind = item.get('type')
        if kind not in ('summary', 'boundary', 'relation'):
            raise ValueError('不支持的导图标注')
        color, line = item.get('color', 'blue'), item.get('line', 'solid')
        if color not in COLORS or line not in ('solid', 'dashed'):
            raise ValueError('标注样式无效')
        a = dict(id=aid, type=kind, label=text(item.get('label', ''), 300, '标注文字'), color=color, line=line)
        if kind == 'relation':
            start, end = item.get('from'), item.get('to')
            if start not in ids or end not in ids or start == end:
                raise ValueError('联系线需要连接两个不同的现有节点')
            direction = item.get('direction', 'single')
            if direction not in ('single', 'both', 'none'):
                raise ValueError('联系线方向无效')
            curve = item.get('curve', -70)
            if isinstance(curve, bool) or not isinstance(curve, (int, float)) or not math.isfinite(curve):
                raise ValueError('联系线弧度无效')
            a.update({'from': start, 'to': end, 'direction': direction, 'curve': max(-800, min(800, curve))})
        else:
            members = item.get('members')
            if not isinstance(members, list) or len(members) < 2 or any(not isinstance(i, str) for i in members):
                raise ValueError('概要或分组至少需要两个同级节点')
            if len(set(members)) != len(members) or any(i not in ids for i in members):
                raise ValueError('概要或分组的节点不存在或重复')
            parent = lookup[members[0]]['parent_id']
            siblings = [n['id'] for n in result if n['parent_id'] == parent]
            indices = sorted(siblings.index(i) for i in members if lookup[i]['parent_id'] == parent)
            if len(indices) != len(members) or indices[-1]-indices[0]+1 != len(indices) or parent is None:
                raise ValueError('概要与分组需要选取连续的同级节点')
            a['members'] = [siblings[i] for i in indices]
        clean.append(a)
    return dict(nodes=sorted(result, key=lambda n: (n['position'], n['name'], n['id'])), annotations=clean)


def remove_nodes(c, ids):
    for nid in sorted(ids):
        for row in c.execute('SELECT paper_id FROM library WHERE node_id=?',(nid,)).fetchall():
            library_manager.remove_membership(c,row['paper_id'],nid)
        c.execute('DELETE FROM refresh_log WHERE node_id=?',(nid,))
    # Clear links within the removed branch before deleting its parents.
    c.executemany('UPDATE nodes SET parent_id=NULL WHERE id=?', ((nid,) for nid in ids))
    c.executemany('DELETE FROM nodes WHERE id=?', ((nid,) for nid in ids))


def discard_legacy_history(c):
    remove_nodes(c, {r['node_id'] for r in c.execute('SELECT node_id FROM map_node_details WHERE hidden=1')})
    c.execute("UPDATE map_editor_document SET history='[]',cursor=0,signature='' WHERE history<>'[]' OR cursor<>0 OR signature<>''")
    library_manager.strip_snapshot_directions(c)


def apply(c, doc, check_removal):
    ids = {n['id'] for n in doc['nodes']}
    removed = {row['id'] for row in c.execute('SELECT id FROM nodes')} - ids
    if removed and check_removal:
        check_removal(removed)
    for n in doc['nodes']:
        c.execute('INSERT OR IGNORE INTO nodes(id,parent_id,name,keywords,position) VALUES(?,NULL,?,?,?)',
                  (n['id'], n['name'], n['keywords'], n['position']))
    for n in doc['nodes']:
        c.execute('UPDATE nodes SET parent_id=?,name=?,keywords=?,position=? WHERE id=?',
                  (n['parent_id'], n['name'], n['keywords'], n['position'], n['id']))
        details = {k: n[k] for k in ('remark', 'notes', 'style', 'color', 'icon', 'link')}
        details.update({k: n[k] for k in ('text_align', 'remark_align') if n.get(k)})
        details.update({k: n[k] for k in ('typography', 'global_typography') if n.get(k)})
        c.execute('INSERT INTO map_node_details VALUES(?,0,?) ON CONFLICT(node_id) DO UPDATE SET hidden=0,details=excluded.details',
                  (n['id'], json.dumps(details, ensure_ascii=False)))
    remove_nodes(c, removed)
    c.execute('UPDATE map_editor_document SET annotations=? WHERE id=1', (json.dumps(doc['annotations'], ensure_ascii=False),))


def action(c, payload, check_removal=None):
    global _history
    c.execute('BEGIN IMMEDIATE')
    current = document(c)
    if payload.get('revision') != current['revision'] or payload.get('fingerprint') != current['fingerprint']:
        raise ValueError('导图已在其他窗口更新，请刷新后再编辑')
    history, cursor = history_for(current['revision'], current['fingerprint'])
    before = dict(nodes=current['nodes'], annotations=current['annotations'])
    command = payload.get('action', 'save')
    if command == 'undo':
        if cursor <= 0:
            raise ValueError('没有可以撤销的操作')
        after = history[cursor-1]['before']
        cursor -= 1
    elif command == 'redo':
        if cursor >= len(history):
            raise ValueError('没有可以重做的操作')
        after = history[cursor]['after']
        cursor += 1
    elif command == 'save':
        root = next(n['id'] for n in before['nodes'] if n['parent_id'] is None)
        after = validate(payload.get('document'), root)
        if after == before:
            return current
        history = history[:cursor] + [dict(before=before, after=after)]
        history = history[-50:]
        cursor = len(history)
    else:
        raise ValueError('不支持的导图操作')
    apply(c, after, check_removal)
    sig = signature(snapshot(c))
    c.execute('UPDATE map_editor_document SET revision=revision+1 WHERE id=1')
    c.commit()
    _history = (current['revision']+1, sig, history, cursor)
    return document(c)
