"""Streamlit flow canvas. No dependencies on the host application."""

from __future__ import annotations

import os
from pathlib import Path

import streamlit.components.v1 as components

_RELEASE = True
_RS = "\x1e"
_US = "\x1f"

_BUILD_DIR = Path(__file__).resolve().parent / "frontend" / "build"

if _RELEASE:
    if not _BUILD_DIR.is_dir():
        raise FileNotFoundError(
            "streamlit_flow_expanded frontend build is missing at "
            f"{_BUILD_DIR}. Run npm run build in the frontend directory."
        )
    _component = components.declare_component("streamlit_flow", path=str(_BUILD_DIR))
else:
    _component = components.declare_component(
        "streamlit_flow",
        url=os.environ.get("STREAMLIT_FLOW_DEV_URL", "http://localhost:3001"),
    )


def encode_flow_rows(rows: list[dict] | None) -> str:
    """Pack node rows into one string.

    Each row is ``text``, ``style``, and flags, separated by ``\\x1f``.
    Rows are separated by ``\\x1e``. ``style`` is ``background|foreground|strip``.
    ``bold`` sets the ``b`` flag. ``warning`` sets the ``w`` flag. Empty
    background or foreground is left blank so the component can use the theme
    colour.
    """

    packed: list[str] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        text = row.get("text")
        text = "" if text is None else str(text)
        text = text.replace(_RS, " ").replace(_US, " ")
        style = str(row.get("style") or "").replace(_RS, "").replace(_US, "")
        flags = ""
        if row.get("bold"):
            flags += "b"
        if row.get("warning"):
            flags += "w"
        packed.append(_US.join((text, style, flags)))
    return _RS.join(packed)


def _node_arg(node: dict) -> dict:
    position = node.get("position")
    point = None
    if isinstance(position, dict) and "x" in position and "y" in position:
        point = {"x": float(position["x"]), "y": float(position["y"])}
    payload = node.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    menu = node.get("menu")
    if not isinstance(menu, dict):
        menu = {}
    return {
        "id": str(node.get("id") or ""),
        "content": str(node.get("content") or ""),
        "position": point,
        "menu": menu,
        "payload": payload,
    }


def _edge_arg(edge: dict) -> dict:
    return {
        "id": str(edge.get("id") or ""),
        "source": str(edge.get("source") or ""),
        "target": str(edge.get("target") or ""),
    }


def _filter_arg(filters) -> list:
    """Ordered filter fields. Options are strings, or ``{value, label}``."""
    if not isinstance(filters, list):
        return []
    clean = []
    for field in filters:
        if not isinstance(field, dict):
            continue
        key = str(field.get("key") or "").strip()
        if not key:
            continue
        label = str(field.get("label") or key)
        options = []
        for option in field.get("options") or []:
            if isinstance(option, str):
                text = option.strip()
                if text:
                    options.append(text)
                continue
            if not isinstance(option, dict):
                continue
            value = option.get("value")
            if value is None:
                continue
            value = str(value)
            shown = option.get("label")
            options.append({"value": value, "label": str(value if shown is None else shown)})
        if options:
            clean.append({"key": key, "label": label, "options": options})
    return clean


def streamlit_flow(
    nodes: list[dict] | None,
    edges: list[dict] | None = None,
    *,
    height: int = 620,
    fit: bool = False,
    viewport: dict | None = None,
    pane_menu: dict | None = None,
    filters: list | None = None,
    tree: bool = True,
    key: str | None = None,
):
    """Draw the flow. Returns the latest click, menu, or drag event, or None.

    ``fit`` fills the parent frame instead of using ``height``.
    ``pane_menu`` is the background right-click menu. Each node menu is the
    ``menu`` dict on that node. Both use the same row shape.
    ``filters`` is the ordered filter list. ``tree`` keeps one parent and
    refuses a cycle.
    """

    safe_nodes = [_node_arg(node) for node in (nodes or []) if isinstance(node, dict)]
    safe_edges = [_edge_arg(edge) for edge in (edges or []) if isinstance(edge, dict)]
    return _component(
        nodes=safe_nodes,
        edges=safe_edges,
        height=int(height),
        fit=bool(fit),
        viewport=viewport if isinstance(viewport, dict) else None,
        pane_menu=pane_menu if isinstance(pane_menu, dict) else {},
        filters=_filter_arg(filters),
        tree=bool(tree),
        key=key,
        default=None,
    )
