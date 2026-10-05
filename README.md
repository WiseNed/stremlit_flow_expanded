# streamlit_flow_component

A self-contained Streamlit component: a left-to-right flow canvas, nodes drawn from a packed style string, and a context menu described as data.

This folder does not depend on a host application. Install it, or copy it out when it moves to its own repo.

## Use

```python
from streamlit_flow_component import encode_flow_rows, streamlit_flow

content = encode_flow_rows([
    {"text": "Parent", "style": "#eceff1|#263238|", "bold": True},
    {"text": "Child line"},
])
event = streamlit_flow(
    nodes=[{"id": "a", "content": content, "position": None, "menu": {}, "payload": {}}],
    edges=[],
    height=640,
    key="flow",
)
```

`style` is `background|foreground|strip`. Leave background or foreground empty and that text follows the Streamlit theme. `strip` is url-safe base64 for a PNG painted across the row.

`bold` sets the `b` flag. `warning` sets the `w` flag. A warning row's text is one reason per line. The canvas draws an icon and a bullet list for that row, and does not treat a particular character as the signal. Set `payload["issue"]` to `True` when that node should be marked on the minimap.

`streamlit_flow` returns a dict only after a left-click, a menu choice, a drag-end (including the first automatic layout), a new edge, or a deleted edge. Pan and zoom do not rerun the app.

Pass the last event's `viewport` back in on the next run if a structure change should keep the camera where it was. `fit=True` fills the parent frame instead of using `height`.

An empty `nodes` list still draws the canvas, so a right-click can open `pane_menu` and create the first node.

`example.py` in this folder draws two nodes, a warning, filters, a node menu, and a background menu that adds a node. From this folder, after `pip install -e .`:

```bash
streamlit run example.py
```

## Context menu

The background menu is `pane_menu`. Each node's menu is its `menu` dict. Both use the same shape. The row name is the key. Inside the row, `__kind` is `group`, `flyout`, `action`, `form`, or `separator`. Other keys are child rows, in dict order. A divider is drawn between groups. A `separator` row draws a line and hides its key.

```python
{
    "Edit": {
        "__kind": "flyout",
        "Note": {
            "__kind": "form",
            "__buttons": ["Apply", "Delete"],
            "__fields": [
                {"label": "Note", "kind": "text", "value": ""},
                {
                    "label": "Status",
                    "kind": "select",
                    "options": ["Open", {"id": "hold", "label": "Hold"}],
                },
            ],
            "__data": {"id": "a"},
        },
        "Toggle issue": {"__kind": "action", "__checked": False},
    },
    "sep": {"__kind": "separator"},
}
```

`__fields` kinds are `select`, `text`, and `number`. A select option is a string, or `{id, label}` when the stored value differs from the label. `__buttons` defaults to `["Apply"]`. The first button submits the form and stays disabled until required selects and numbers are filled. Set `"required": False` on a field to leave it optional. Text is never required. `__disabled` greys a row. `__checked` draws a tick. `__data` is returned unchanged.

Choosing an action, or a form button, returns:

- `id`: the node id, or `""` on the background
- `path`: row labels from the top, separators omitted
- `button`: the form button, or `""` for an action
- `values`: form answers keyed by label, otherwise `{}`. A select returns the option id when one is present
- `position`: the right-click in chart coordinates
- `data`: the chosen row's `__data`

## Filters

`filters` is an ordered list. The canvas shows it as given and does not sort or rename the entries.

```python
filters = [
    {
        "key": "status",
        "label": "Status",
        "options": [
            "Open",
            {"value": "Hold", "label": "On hold"},
        ],
    },
]
```

An option is a string, or `{value, label}` when the shown text differs from the match token. Each node carries the tokens it matches in `payload["filters"]`, a dict of key to list of strings. Within a field, any selected value matches. Across fields, every field that is not fully selected must match. A node that lacks a restricted field does not match. Nodes that do not match stay on the chart: they lose their colours, they cannot be clicked or opened, and they can still be dragged.

## Edges

`tree=True` (the default) allows one incoming edge. Dragging a second one replaces the first and emits `reparent` with `payload["parent"]`. A cycle, including a self-link, is refused and not emitted. `tree=False` allows another parent and a cycle, and emits `connect` instead of `reparent`.

Select an edge and press Delete or Backspace to emit `detach`. That does not delete the node. Nodes are not deleted by the keyboard.

Sibling order and the automatic layout follow the order of `nodes` and `edges`. The canvas does not sort ids.

## Develop

Production loads `streamlit_flow_component/frontend/build`. For the dev server:

1. In `streamlit_flow_component/__init__.py`, set `_RELEASE = False`.
2. `npm start` in `streamlit_flow_component/frontend/` (port 3001).
3. Set `_RELEASE = True` and `npm run build` before normal use.
