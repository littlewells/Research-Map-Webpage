"""Paper label definitions retain stable IDs for existing assignments."""
import re

DEFAULTS = [
    dict(id='里程碑', name='里程碑', icon='', color='#785b2a', icon_color='#785b2a', background='#f1e7d3', archived=False),
    dict(id='启发性', name='启发性', icon='', color='#526784', icon_color='#526784', background='#e4eaf3', archived=False),
]


def validate(items, stored=None):
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError('最多可保存 100 个论文标签')
    result = []
    ids, names = set(), set()
    for row in items:
        if not isinstance(row, dict):
            raise ValueError('论文标签格式不正确')
        key, name, icon = (row.get(field, '') for field in ('id', 'name', 'icon'))
        archived = row.get('archived', False)
        if not isinstance(key, str) or (key not in ('里程碑', '启发性') and not re.fullmatch(r'tag-[0-9a-f]{32}', key)) or key in ids:
            raise ValueError('论文标签标识无效')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 24 or name.strip().casefold() in names or not isinstance(icon, str) or len(icon.strip()) > 8 or type(archived) is not bool:
            raise ValueError('标签名称需为 1–24 字且不能重复，图标最多 8 字符')
        colors = {field: row.get(field) for field in ('color', 'icon_color', 'background')}
        if any(not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value) for value in colors.values()):
            raise ValueError('论文标签颜色格式不正确')
        ids.add(key)
        names.add(name.strip().casefold())
        result.append(dict(id=key, name=name.strip(), icon=icon.strip(), archived=archived, **colors))
    if stored is not None and any(row['id'] not in ids for row in stored):
        raise ValueError('已有标签应停用，以保留论文上的历史标记')
    return result


def check_tag(value, definitions, current=''):
    if not isinstance(value, str):
        raise ValueError('论文标签不正确')
    if value == current or value == '':
        return
    enabled = {row['id'] for row in definitions if not row.get('archived')}
    if value in enabled or (value == '里程碑,启发性' and {'里程碑', '启发性'} <= enabled):
        return
    raise ValueError('论文标签不存在或已停用')
