// In-page monitor windows share one authenticated connection. No extra login,
// browser popup, or second encoder is needed when moving or resizing a screen.
export function screenWindows(root, { focus, release, controls, popout, takeBack, changed = () => {} }) {
  const host = root.querySelector("#videos"), dock = root.querySelector("#window-dock");
  const lifetime = new AbortController(), windows = new Map();
  function raise(item) {
    const others = [...windows.values()].filter(value => value !== item)
      .sort((a, b) => Number(a.figure.style.zIndex) - Number(b.figure.style.zIndex));
    for (const [index, value] of [...others, item].entries()) value.figure.style.zIndex = String(40 + index);
  }
  const workspace = () => {
    if (document.fullscreenElement === host) return { left: 0, top: 0, width: innerWidth };
    const inset = root.closest(".platform-inset");
    const left = Math.max(0, inset?.getBoundingClientRect().left || 0);
    const top = Math.max(48, (inset?.querySelector(".platform-header")?.getBoundingClientRect().bottom || 44) + 4);
    return { left, top, width: innerWidth - left };
  };
  const on = (node, event, handler) => node.addEventListener(event, handler, { signal: lifetime.signal });
  const button = (text, label, handler) => {
    const element = document.createElement("button");
    element.type = "button"; element.textContent = text;
    element.title = label; element.setAttribute("aria-label", label);
    on(element, "click", handler);
    return element;
  };
  function bounds(value) {
    const area = workspace();
    const width = Math.min(Math.max(280, value.width), area.width - 16);
    const height = Math.min(Math.max(120, value.height), Math.max(120, innerHeight - area.top - 16));
    return { width, height, x: Math.max(area.left + 8, Math.min(value.x, innerWidth - width - 8)), y: Math.max(area.top, Math.min(value.y, innerHeight - height - 8)) };
  }
  function place(item, value) {
    item.box = bounds(value);
    Object.assign(item.figure.style, { left: item.box.x + "px", top: item.box.y + "px", width: item.box.width + "px", height: item.box.height + "px" });
  }
  function restore(item, returning = false, focusTarget = true) {
    if (item.popped && !returning) return;
    if (item.popped) takeBack?.(item.id);
    item.figure.hidden = false;
    item.restore.hidden = true;
    raise(item);
    if (focusTarget) focus(item.id);
    changed();
  }
  function minimize(item) {
    release(); item.figure.hidden = true; item.restore.hidden = false;
    changed();
  }
  function snap(item, side, focusTarget = true) {
    release(); restore(item, false, focusTarget);
    const margin = 12, area = workspace(), top = area.top;
    const width = side === "full" || area.width < 600 ? area.width - margin * 2 : (area.width - margin * 3) / 2;
    place(item, { x: side === "right" ? innerWidth - width - margin : area.left + margin, y: top, width, height: Math.min(innerHeight - top - 16, side === "full" ? Infinity : width * 9 / 16 + 34) });
  }
  function tile(item, index, count) {
    const area = workspace(), columns = area.width >= 700 ? 2 : 1, rows = Math.ceil(count / columns);
    const width = (area.width - 12 * (columns + 1)) / columns;
    const height = (innerHeight - area.top - 12 * (rows + 1)) / rows;
    place(item, { x: area.left + 12 + index % columns * (width + 12), y: area.top + 12 + Math.floor(index / columns) * (height + 12), width, height });
  }
  function add(id, label, video, index, count) {
    const figure = document.createElement("figure"), caption = document.createElement("figcaption");
    figure.className = "pc-screen-window"; figure.dataset.screenId = id;
    figure.setAttribute("aria-label", label + " window");
    const name = document.createElement("span"), badge = document.createElement("span");
    name.className = "pc-window-name"; name.textContent = label;
    badge.className = "pc-window-fps";
    caption.append(name, badge);
    caption.title = "Drag to move · double-click to fill screen";
    const item = { id, figure, video, badge, box: null, restore: null };
    item.restore = button("+ " + label, "Restore " + label, () => restore(item, true));
    item.restore.hidden = true; dock.append(item.restore);
    caption.append(
      button("↗", "Open " + label + " in a tab", () => popout?.(id)),
      button("◧", "Snap " + label + " left", () => snap(item, "left")),
      button("◨", "Snap " + label + " right", () => snap(item, "right")),
      button("□", "Fill screen with " + label, () => snap(item, "full")),
      button("−", "Minimize " + label, () => minimize(item)),
    );
    const resize = button("◢", "Resize " + label, () => {});
    resize.className = "pc-window-resize";
    on(resize, "keydown", event => {
      const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
      if (!delta) return;
      event.preventDefault(); place(item, { ...item.box, width: item.box.width + delta[0], height: item.box.height + delta[1] });
    });
    let gesture;
    const begin = (event, resizing) => {
      if (event.button !== 0 || (!resizing && event.target.closest("button"))) return;
      event.preventDefault(); release(); restore(item);
      gesture = { x: event.clientX, y: event.clientY, box: { ...item.box }, resizing, pointer: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
    };
    on(caption, "pointerdown", event => begin(event, false));
    on(resize, "pointerdown", event => begin(event, true));
    for (const target of [caption, resize]) {
      on(target, "pointermove", event => {
        if (!gesture || gesture.pointer !== event.pointerId) return;
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        place(item, gesture.resizing ? { ...gesture.box, width: gesture.box.width + dx, height: gesture.box.height + dy } : { ...gesture.box, x: gesture.box.x + dx, y: gesture.box.y + dy });
      });
      const finish = event => {
        gesture = null;
        if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      };
      on(target, "pointerup", finish); on(target, "pointercancel", finish);
    }
    on(caption, "dblclick", event => { if (!event.target.closest("button")) snap(item, "full"); });
    on(figure, "pointerdown", () => { raise(item); focus(id); });
    figure.append(caption, video, resize); host.append(figure); windows.set(id, item);
    const area = workspace(), sideBySide = count > 1 && area.width > 1600;
    const preview = !sideBySide && index > 0;
    const width = sideBySide ? (area.width - 48) / 2 : preview ? Math.min(360, area.width - 32) : area.width - 24;
    const height = Math.min(width * 9 / 16 + 34, innerHeight - area.top - 16);
    if (count > 2) tile(item, index, count);
    else place(item, { x: preview ? innerWidth - width - 12 : area.left + (sideBySide ? 16 + index * (width + 16) : 12), y: preview ? innerHeight - height - 12 : area.top, width, height });
    raise(item);
    return figure;
  }
  on(window, "resize", () => { for (const item of windows.values()) place(item, item.box); });
  on(document, "pointerdown", event => {
    if (!root.contains(event.target) && !controls?.contains(event.target) && windows.size) for (const item of windows.values()) minimize(item);
  });
  return {
    add,
    setPopped(id, value) {
      const item = windows.get(id); if (!item) return;
      item.popped = value; item.figure.hidden = value || root.dataset.view !== "computer";
      item.restore.hidden = !item.figure.hidden;
      item.restore.textContent = (value ? "↙ " : "+ ") + item.figure.getAttribute("aria-label").replace(/ window$/, "");
      changed();
    },
    minimize: () => { for (const item of windows.values()) minimize(item); },
    arrange(layout, focused) {
      const list = [...windows.values()];
      if (layout === "windows") { for (const item of list) restore(item, false, false); if (focused) focus(focused); return; }
      for (const [index, item] of list.entries()) {
        if (layout === "full" && item.id !== focused) { minimize(item); continue; }
        restore(item, false, false);
        if (layout === "rows") { const area = workspace(), height = (innerHeight - area.top - 64) / list.length; place(item, { x: area.left + 12, y: area.top + index * height, width: area.width - 24, height: height - 8 }); }
        else if (layout === "columns" && list.length > 2) tile(item, index, list.length);
        else snap(item, layout === "full" || list.length === 1 ? "full" : index === 0 ? "left" : "right", false);
      }
      if (focused) focus(focused);
    },
    metrics(values, focused) {
      for (const item of windows.values()) {
        item.figure.classList.toggle("focused", item.id === focused);
        const row = values.find(value => value.screenId === item.id);
        item.badge.textContent = row?.fps == null ? (item.id === focused ? "Active" : "Preview · 5 FPS") : row.fps.toFixed(0) + " FPS" + (item.id === focused ? "" : " · preview");
      }
    },
    clear() { windows.clear(); host.replaceChildren(); dock.replaceChildren(); },
    dispose() { lifetime.abort(); windows.clear(); dock.replaceChildren(); },
  };
}
