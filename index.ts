/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 S1ckZer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { PopoutWindowStore } from "@webpack/common";

const TARGET_RATIO = 16 / 9;
const MAX_ZOOM = 8;

// x and y are the offset of the visible center from the stream center, as a fraction of the stream size
interface View { x: number; y: number; zoom: number; }
type Geometry = ReturnType<typeof geometry>;

const views = new WeakMap<HTMLVideoElement, View>();
const cropped = new WeakSet<HTMLVideoElement>();
const resized = new WeakMap<HTMLVideoElement, HTMLElement[]>();
const originals = new WeakMap<HTMLElement, string>();
const written = new WeakMap<HTMLElement, string>();
const observers = new Map<Document, ResizeObserver>();
let observed = new WeakSet<HTMLVideoElement>();
let drag: { video: HTMLVideoElement; startX: number; startY: number; start: View; moved: boolean; } | undefined;
let timer: ReturnType<typeof setInterval>;

function geometry(video: HTMLVideoElement) {
    const ratio = video.videoWidth / video.videoHeight;
    const boxW = video.clientWidth;
    const boxH = video.clientHeight;
    const contentH = Math.min(boxH, boxW / ratio);
    const cropW = contentH * TARGET_RATIO;
    return { boxW, boxH, contentW: contentH * ratio, contentH, cropW, scale: boxW / cropW, minZoom: TARGET_RATIO / ratio };
}

function viewOf(video: HTMLVideoElement) {
    return views.get(video) ?? { x: 0, y: 0, zoom: 1 };
}

function clampView(view: View, g: Geometry): View {
    const maxX = Math.max(0, (1 - g.cropW / view.zoom / g.contentW) / 2);
    const maxY = Math.max(0, (1 - 1 / view.zoom) / 2);
    return { zoom: view.zoom, x: Math.max(-maxX, Math.min(maxX, view.x)), y: Math.max(-maxY, Math.min(maxY, view.y)) };
}

// Remembers Discord's value for restoring, and picks up a new one whenever Discord rewrites it
function override(e: HTMLElement, prop: string, value: (original: string) => string) {
    if (e.style.getPropertyValue(prop) !== written.get(e)) {
        originals.set(e, e.style.getPropertyValue(prop));
    }
    e.style.setProperty(prop, value(originals.get(e)!), "important");
    written.set(e, e.style.getPropertyValue(prop));
}

function restore(e: HTMLElement, prop: string) {
    e.style.setProperty(prop, originals.get(e)!);
    written.delete(e);
}

function isSizer(e: HTMLElement, ratio: number) {
    const aspect = e.style.aspectRatio;
    if (aspect === "") return false;
    if (aspect === written.get(e)) return true;
    const [w, h = "1"] = aspect.split("/");
    return Math.abs(parseFloat(w) / parseFloat(h) - ratio) < ratio * 0.01;
}

// Discord sizes the focused player with an aspect-ratio on a sizer element and width = free height * ratio on its parent
function resizeBox(video: HTMLVideoElement, ratio: number) {
    let sizer = video.parentElement;
    while (sizer && !isSizer(sizer, ratio)) sizer = sizer.parentElement;
    if (!sizer) return;

    const wrapper = sizer.parentElement!;
    override(sizer, "aspect-ratio", () => `${TARGET_RATIO}`);
    override(wrapper, "width", width => `${parseFloat(width) * TARGET_RATIO / ratio}px`);
    resized.set(video, [sizer, wrapper]);
}

function restoreBox(video: HTMLVideoElement) {
    const elements = resized.get(video);
    if (!elements) return;
    restore(elements[0], "aspect-ratio");
    restore(elements[1], "width");
    resized.delete(video);
}

function reset(video: HTMLVideoElement) {
    video.style.removeProperty("clip-path");
    video.style.removeProperty("transform");
    cropped.delete(video);
    restoreBox(video);
}

function crop(video: HTMLVideoElement) {
    // No frame yet while a stream starts, keep the current state
    if (video.videoWidth === 0) return;
    const ratio = video.videoWidth / video.videoHeight;
    if (ratio <= TARGET_RATIO) {
        reset(video);
        return;
    }

    resizeBox(video, ratio);
    const g = geometry(video);
    if (g.boxW / g.boxH > TARGET_RATIO * 1.01) {
        reset(video);
        return;
    }

    const view = clampView(viewOf(video), g);
    views.set(video, view);
    cropped.add(video);

    const winW = g.cropW / view.zoom;
    const winH = g.contentH / view.zoom;
    const cx = g.boxW / 2 + view.x * g.contentW;
    const cy = g.boxH / 2 + view.y * g.contentH;
    const s = g.scale * view.zoom;
    video.style.setProperty("clip-path", `inset(${cy - winH / 2}px ${g.boxW - cx - winW / 2}px ${g.boxH - cy - winH / 2}px ${cx - winW / 2}px)`, "important");
    video.style.setProperty("transform", `translate(${(g.boxW / 2 - cx) * s}px, ${(g.boxH / 2 - cy) * s}px) scale(${s})`, "important");
}

function videoAt(e: MouseEvent) {
    return [...e.view!.document.querySelectorAll("video")].find(v => {
        const r = v.parentElement!.getBoundingClientRect();
        return cropped.has(v) && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
}

// Replaces Discord's own zoom, which still zooms and pans as if the stream were ultrawide
function onWheel(e: WheelEvent) {
    const video = videoAt(e);
    if (!video) return;
    e.preventDefault();
    e.stopPropagation();

    const g = geometry(video);
    const view = viewOf(video);
    const zoom = Math.max(g.minZoom, Math.min(MAX_ZOOM, view.zoom * Math.exp(-e.deltaY * 0.0015)));
    const r = video.parentElement!.getBoundingClientRect();
    const shift = 1 / view.zoom - 1 / zoom;
    views.set(video, {
        zoom,
        x: view.x + (e.clientX - r.left - g.boxW / 2) / g.scale * shift / g.contentW,
        y: view.y + (e.clientY - r.top - g.boxH / 2) / g.scale * shift / g.contentH
    });
    crop(video);
}

function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const video = videoAt(e);
    if (!video) return;
    drag = { video, startX: e.clientX, startY: e.clientY, start: viewOf(video), moved: false };
}

function onMouseMove(e: MouseEvent) {
    if (!drag) return;
    if ((e.buttons & 1) === 0) {
        drag = undefined;
        return;
    }

    drag.moved ||= Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3;
    const g = geometry(drag.video);
    const s = g.scale * drag.start.zoom;
    views.set(drag.video, {
        zoom: drag.start.zoom,
        x: drag.start.x - (e.clientX - drag.startX) / s / g.contentW,
        y: drag.start.y - (e.clientY - drag.startY) / s / g.contentH
    });
    crop(drag.video);
}

// Clicking a focused stream unfocuses it, so the click that ends a drag must not reach Discord
function onClick(e: MouseEvent) {
    const moved = drag?.moved;
    drag = undefined;
    if (!moved) return;
    e.stopPropagation();
    e.preventDefault();
}

function allDocuments() {
    const popouts = PopoutWindowStore.getWindowKeys()
        .filter(k => k !== "DISCORD_OutOfProcessOverlay")
        .map(k => PopoutWindowStore.getWindow(k))
        .filter(w => w !== undefined);
    return [document, ...popouts.map(w => w.document)];
}

// ResizeObserver callbacks run before paint, so Discord resizing the player back never becomes visible
function track(video: HTMLVideoElement) {
    if (!observed.has(video)) {
        observed.add(video);
        observers.get(video.ownerDocument)!.observe(video);
    }
    crop(video);
}

function onVideoEvent(e: Event) {
    const target = e.target as HTMLElement;
    if (target.nodeName === "VIDEO") track(target as HTMLVideoElement);
}

function onResize(entries: ResizeObserverEntry[]) {
    entries.forEach(entry => crop(entry.target as HTMLVideoElement));
}

function listen(doc: Document) {
    observers.set(doc, new (doc.defaultView as typeof window).ResizeObserver(onResize));
    doc.addEventListener("loadedmetadata", onVideoEvent, true);
    doc.addEventListener("resize", onVideoEvent, true);
    doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
    doc.addEventListener("mousedown", onMouseDown, true);
    doc.addEventListener("mousemove", onMouseMove, true);
    doc.addEventListener("click", onClick, true);
}

function unlisten(doc: Document) {
    observers.get(doc)!.disconnect();
    doc.removeEventListener("loadedmetadata", onVideoEvent, true);
    doc.removeEventListener("resize", onVideoEvent, true);
    doc.removeEventListener("wheel", onWheel, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("mousemove", onMouseMove, true);
    doc.removeEventListener("click", onClick, true);
    doc.querySelectorAll("video").forEach(reset);
}

function scan() {
    for (const doc of allDocuments()) {
        if (!observers.has(doc)) listen(doc);
        doc.querySelectorAll("video").forEach(track);
    }
}

export default definePlugin({
    name: "UltrawideStreamCrop",
    description: "Shows ultrawide streams as 16:9. Drag to pan, scroll to zoom",
    authors: [{ name: "S1ckZer", id: 0n }],

    start() {
        scan();
        timer = setInterval(scan, 1000);
    },

    stop() {
        clearInterval(timer);
        observers.forEach((_, doc) => unlisten(doc));
        observers.clear();
        observed = new WeakSet();
    }
});
