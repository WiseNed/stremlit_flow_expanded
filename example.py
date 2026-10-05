"""Small chart: styled nodes, a warning, filters, and both context menus."""

import streamlit as st

from streamlit_flow_expanded import encode_flow_rows, streamlit_flow

st.set_page_config(page_title="Flow canvas", layout="wide")
st.title("Flow canvas")

if "graph" not in st.session_state:
    st.session_state.graph = {
        "nodes": [
            {
                "id": "pump",
                "title": "Pump",
                "note": "",
                "status": "Open",
                "issue": False,
                "position": None,
            },
            {
                "id": "seal",
                "title": "Seal",
                "note": "Check wear",
                "status": "Hold",
                "issue": True,
                "position": None,
            },
        ],
        "edges": [{"id": "pump>seal", "source": "pump", "target": "seal"}],
        "next_id": 1,
    }
    st.session_state.flow_viewport = None
    st.session_state.flow_event = None
    st.session_state.flow_sig = None


def _content(node: dict) -> str:
    rows = [
        {"text": node["title"], "style": "#eceff1|#263238|", "bold": True},
        {
            "text": node["status"],
            "style": "#fff8e1|#e65100|" if node["status"] == "Hold" else "#e8f5e9|#1b5e20|",
        },
    ]
    if node["note"]:
        rows.append({"text": node["note"]})
    if node["issue"]:
        rows.insert(
            0,
            {
                "text": "Needs a drawing",
                "style": "#fff3e0|#e65100|",
                "bold": True,
                "warning": True,
            },
        )
    return encode_flow_rows(rows)


def _node_menu(node: dict) -> dict:
    return {
        "Edit": {
            "__kind": "flyout",
            "Note": {
                "__kind": "form",
                "__buttons": ["Apply", "Delete"],
                "__fields": [{"label": "Note", "kind": "text", "value": node["note"]}],
                "__data": {"id": node["id"]},
            },
            "Toggle issue": {"__kind": "action", "__checked": bool(node["issue"])},
        },
    }


def _pane_menu() -> dict:
    return {
        "Create": {
            "__kind": "group",
            "New node": {
                "__kind": "form",
                "__fields": [
                    {"label": "Title", "kind": "text", "value": "", "required": False},
                    {
                        "label": "Status",
                        "kind": "select",
                        "options": ["Open", "Hold"],
                        "required": False,
                    },
                ],
            },
        },
    }


def _filters() -> list[dict]:
    return [
        {
            "key": "status",
            "label": "Status",
            "options": ["Open", {"value": "Hold", "label": "On hold"}],
        },
    ]


def _find(node_id: str) -> dict | None:
    for node in st.session_state.graph["nodes"]:
        if node["id"] == node_id:
            return node
    return None


def _apply(event: dict) -> None:
    graph = st.session_state.graph
    kind = event.get("type")
    if isinstance(event.get("viewport"), dict):
        st.session_state.flow_viewport = event["viewport"]
    if kind == "drag":
        positions = event.get("positions") if isinstance(event.get("positions"), dict) else {}
        for node in graph["nodes"]:
            point = positions.get(node["id"])
            if isinstance(point, dict) and "x" in point and "y" in point:
                node["position"] = {"x": float(point["x"]), "y": float(point["y"])}
        return
    if kind == "reparent":
        child = str(event.get("id") or "")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        parent = str(payload.get("parent") or "")
        if child and parent:
            graph["edges"] = [edge for edge in graph["edges"] if edge["target"] != child]
            graph["edges"].append(
                {"id": f"{parent}>{child}", "source": parent, "target": child}
            )
        return
    if kind == "detach":
        child = str(event.get("id") or "")
        graph["edges"] = [edge for edge in graph["edges"] if edge["target"] != child]
        return
    if kind != "menu":
        return
    path = [str(part) for part in (event.get("path") or [])]
    button = str(event.get("button") or "")
    values = event.get("values") if isinstance(event.get("values"), dict) else {}
    if not str(event.get("id") or "").strip() and path == ["Create", "New node"] and button == "Apply":
        title = str(values.get("Title") or "").strip() or "New node"
        status = str(values.get("Status") or "").strip() or "Open"
        if status not in ("Open", "Hold"):
            status = "Open"
        number = int(graph["next_id"])
        graph["next_id"] = number + 1
        point = event.get("position") if isinstance(event.get("position"), dict) else None
        position = None
        if isinstance(point, dict) and "x" in point and "y" in point:
            position = {"x": float(point["x"]), "y": float(point["y"])}
        graph["nodes"].append(
            {
                "id": f"n{number}",
                "title": title,
                "note": "",
                "status": status,
                "issue": False,
                "position": position,
            }
        )
        return
    node = _find(str(event.get("id") or ""))
    if node is None:
        return
    if path == ["Edit", "Note"] and button == "Delete":
        node["note"] = ""
    elif path == ["Edit", "Note"] and button == "Apply":
        node["note"] = str(values.get("Note") or "")
    elif path == ["Edit", "Toggle issue"]:
        node["issue"] = not bool(node["issue"])


graph = st.session_state.graph
nodes = []
for node in graph["nodes"]:
    nodes.append(
        {
            "id": node["id"],
            "content": _content(node),
            "position": node["position"],
            "menu": _node_menu(node),
            "payload": {
                "issue": bool(node["issue"]),
                "filters": {"status": [node["status"]]},
            },
        }
    )

event = streamlit_flow(
    nodes,
    graph["edges"],
    height=640,
    viewport=st.session_state.flow_viewport,
    pane_menu=_pane_menu(),
    filters=_filters(),
    tree=True,
    key="example_flow",
)
if isinstance(event, dict):
    sig = (
        event.get("type"),
        event.get("seq"),
        event.get("id"),
        tuple(str(part) for part in (event.get("path") or [])),
        str(event.get("button") or ""),
    )
    if st.session_state.flow_sig != sig:
        st.session_state.flow_sig = sig
        st.session_state.flow_event = event
        _apply(event)
        st.rerun()

st.subheader("Latest event")
st.json(st.session_state.flow_event)
