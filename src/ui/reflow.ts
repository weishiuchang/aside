/**
 * Moves the main conversation out from under aside 1 instead of drawing over it. pi's fullscreen
 * mode lays the screen out as a tree; while the stack is open its root is wrapped so an empty area
 * takes the place of aside 1 (right half when wide, top half when tall) and pi's own layout re-wraps
 * into the rest. The empty area keeps aside 1's size at any depth, so stacking more asides (which
 * cover the whole screen) does not re-wrap the conversation. pi's regular mode has no layout tree:
 * there the aside keeps drawing over the conversation.
 *
 * Re-wrapping keeps the conversation's first visible line on top (see anchor.ts): pi's scroll view
 * keeps a row number, which shows other text once the lines above re-wrap.
 */

import { type Component, Container, HStack, isViewportTUI, type ScrollView, type TUI, type TuiMouseEvent, VStack } from "@earendil-works/pi-tui";
import { anchorAt, anchorRow, lineAnchor, rowAt } from "./anchor.ts";
import { orientation, overlayRows, sideWidth } from "./layout.ts";

/** Empty space whose size is read on every render; the layout measures it to size its slot. */
class Gap implements Component {
	constructor(private size: () => { cols: number; rows: number }) {}

	render(): string[] {
		const { cols, rows } = this.size();
		return cols > 0 && rows > 0 ? Array.from({ length: rows }, () => " ".repeat(cols)) : [];
	}

	invalidate() {}
}

/** pi-tui's key for a component's layout node; a registered symbol, though pi-tui does not export it. */
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/**
 * pi's layout, laid out by its own layout node, but measured as empty. A horizontal stack measures
 * every entry's height by rendering it, which for pi's layout renders the whole conversation a
 * second time each frame; here the stack gives it the full height anyway.
 */
class Unmeasured implements Component {
	constructor(readonly inner: Component) {}

	render(): string[] {
		return [];
	}

	invalidate() {
		this.inner.invalidate();
	}

	handleMouse(event: TuiMouseEvent) {
		return this.inner.handleMouse?.(event);
	}

	[LAYOUT_NODE]() {
		return (this.inner as unknown as Record<symbol, () => unknown>)[LAYOUT_NODE]();
	}
}

/** pi sets its layout root through the typed API but keeps it in a field that is not typed. */
function layoutRoot(tui: TUI): Component | undefined {
	return (tui as unknown as { layoutRoot?: Component }).layoutRoot;
}

/** The conversation's scroll view; pi keeps the lookup private. */
function primaryScrollView(tui: TUI): ScrollView | undefined {
	return (tui as unknown as { getPrimaryScrollView?: () => ScrollView | undefined }).getPrimaryScrollView?.();
}

/** Put an own method of `target` back as it was: a shadowing own property, or none. */
function override<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
	const own = Object.getOwnPropertyDescriptor(target, key);
	target[key] = value;
	return () => {
		if (own) Object.defineProperty(target, key, own);
		else delete target[key];
	};
}

/** Scroll views with anchoring hooks, until their release takes effect. */
const anchored = new WeakMap<ScrollView, { retain: () => () => void }>();

/**
 * Keep the transcript's first visible line on top across width changes, unless it follows the end.
 * A layout pass renders the content, then settles the scroll position, so the new position applies
 * in the same frame. Returns the release: the hooks stay through the next render after it, which
 * re-wraps the conversation to the full window.
 */
function anchorTranscript(tui: TUI): (() => void) | undefined {
	const view = primaryScrollView(tui);
	const content = view?.children[0];
	if (!view || !content) return;
	// Reopened before the release took effect: keep the hooks that are still there.
	const active = anchored.get(view);
	if (active) return active.retain();
	const render = content.render;
	// A plain container is anchored through its children; anything else by its own lines.
	const shadow = content instanceof Container && render === Container.prototype.render ? new Container() : undefined;
	const updateLayout = view.updateLayout;
	// The transcript spans the window until the aside takes its share.
	let width = view.getContentWidth(tui.terminal.columns);
	let top: number | undefined;
	let releasing = false;
	let done = false;
	const release = () => {
		releasing = true;
	};
	anchored.set(view, {
		retain: () => {
			releasing = false;
			return release;
		},
	});

	const unrender = override(content, "render", (w: number) => {
		if (w !== width && !view.isFollowingEnd) {
			if (shadow) {
				shadow.children = (content as Container).children;
				top = rowAt(shadow, w, anchorAt(shadow, width, view.scrollTop));
			} else {
				top = anchorRow(render.call(content, w), lineAnchor(render.call(content, width), view.scrollTop));
			}
		}
		width = w;
		if (releasing) {
			unrender();
			anchored.delete(view);
			done = true;
		}
		return render.call(content, w);
	});
	const unlayout = override(view, "updateLayout", (contentHeight: number, viewportHeight: number, requestRender: () => void) => {
		updateLayout.call(view, contentHeight, viewportHeight, requestRender);
		if (top !== undefined) {
			const row = top;
			top = undefined;
			view.scrollTo(row);
		}
		if (done) unlayout();
	});
	return release;
}

/** Wrap pi's layout so it leaves aside 1's area empty. Returns the undo, or nothing in regular mode. */
export function reflowAround(tui: TUI): (() => void) | undefined {
	if (!isViewportTUI(tui)) return;
	const root = layoutRoot(tui);
	if (!root || typeof (root as unknown as Record<symbol, unknown>)[LAYOUT_NODE] !== "function") return;
	const release = anchorTranscript(tui);
	const mode = () => orientation(tui.terminal.columns, tui.terminal.rows);
	const top = new Gap(() => (mode() === "stacked" ? { cols: 1, rows: overlayRows(tui, 1) } : { cols: 0, rows: 0 }));
	const side = new Gap(() => (mode() === "side" ? { cols: sideWidth(tui.terminal.columns), rows: 1 } : { cols: 0, rows: 0 }));
	const wrapped = new VStack([
		{ component: top, shrink: 0 },
		{ component: new HStack([{ component: new Unmeasured(root), basis: 0, grow: 1 }, { component: side, shrink: 0 }], { align: "stretch" }), basis: 0, grow: 1 },
	]);
	tui.setLayoutRoot(wrapped);
	return () => {
		release?.();
		if (layoutRoot(tui) === wrapped) tui.setLayoutRoot(root);
	};
}
