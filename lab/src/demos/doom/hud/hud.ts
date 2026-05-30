// DOM-based Doom HUD overlay (health, armor, ammo, weapon, keys, messages).
// Implemented as a fixed-position canvas/DOM layer so it costs nothing in the
// WebGPU bundle and never touches the parity-tested engine.

import type { Player } from "../player/player.js";
import { Pickup } from "../mobj/info.js";

export class DoomHud {
    private readonly root: HTMLDivElement;
    private readonly healthEl: HTMLSpanElement;
    private readonly armorEl: HTMLSpanElement;
    private readonly ammoEl: HTMLSpanElement;
    private readonly weaponEl: HTMLSpanElement;
    private readonly keysEl: HTMLSpanElement;
    private readonly messageEl: HTMLDivElement;
    private readonly painEl: HTMLDivElement;

    constructor(private readonly player: Player) {
        const root = document.createElement("div");
        root.style.cssText = [
            "position:fixed",
            "left:0",
            "right:0",
            "bottom:0",
            "pointer-events:none",
            "font-family:'Courier New',monospace",
            "font-weight:bold",
            "z-index:50",
            "user-select:none",
        ].join(";");

        const pain = document.createElement("div");
        pain.style.cssText = [
            "position:fixed",
            "inset:0",
            "pointer-events:none",
            "background:#ff0000",
            "opacity:0",
            "transition:opacity 0.1s linear",
            "z-index:49",
        ].join(";");
        this.painEl = pain;

        const message = document.createElement("div");
        message.style.cssText = [
            "position:fixed",
            "left:12px",
            "top:10px",
            "color:#e8e8b0",
            "font-size:18px",
            "text-shadow:2px 2px 0 #000",
            "opacity:0",
            "transition:opacity 0.3s linear",
        ].join(";");
        this.messageEl = message;

        const bar = document.createElement("div");
        bar.style.cssText = [
            "display:flex",
            "justify-content:space-around",
            "align-items:center",
            "gap:18px",
            "padding:8px 20px",
            "background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0.65) 100%)",
            "color:#ff4030",
            "font-size:26px",
            "text-shadow:2px 2px 0 #000",
        ].join(";");

        this.healthEl = DoomHud.field();
        this.armorEl = DoomHud.field();
        this.ammoEl = DoomHud.field();
        this.weaponEl = DoomHud.field();
        this.weaponEl.style.color = "#d0d0d0";
        this.weaponEl.style.fontSize = "18px";
        this.keysEl = DoomHud.field();

        bar.appendChild(DoomHud.group("HEALTH", this.healthEl));
        bar.appendChild(DoomHud.group("ARMOR", this.armorEl));
        bar.appendChild(DoomHud.group("AMMO", this.ammoEl));
        bar.appendChild(DoomHud.group("WEAPON", this.weaponEl));
        bar.appendChild(DoomHud.group("KEYS", this.keysEl));

        root.appendChild(bar);
        document.body.appendChild(pain);
        document.body.appendChild(message);
        document.body.appendChild(root);
        this.root = root;
    }

    private static field(): HTMLSpanElement {
        const s = document.createElement("span");
        s.textContent = "0";
        return s;
    }

    private static group(label: string, value: HTMLElement): HTMLDivElement {
        const g = document.createElement("div");
        g.style.cssText = "display:flex;flex-direction:column;align-items:center;line-height:1.1";
        const l = document.createElement("span");
        l.textContent = label;
        l.style.cssText = "font-size:11px;color:#a08070;letter-spacing:1px";
        g.appendChild(value);
        g.appendChild(l);
        return g;
    }

    flashMessage(text: string): void {
        this.messageEl.textContent = text;
        this.messageEl.style.opacity = "1";
    }

    update(): void {
        const p = this.player;
        this.healthEl.textContent = `${p.health}%`;
        this.armorEl.textContent = `${p.armor}%`;
        const ammo = p.currentAmmo();
        this.ammoEl.textContent = ammo < 0 ? "--" : `${ammo}`;
        this.weaponEl.textContent = p.weaponName();
        this.keysEl.textContent = DoomHud.keyGlyphs(p) || "--";
        this.messageEl.style.opacity = p.messageTics > 0 ? "1" : "0";
        this.painEl.style.opacity = (p.painFlash * 0.4).toFixed(2);
    }

    private static keyGlyphs(p: Player): string {
        const out: string[] = [];
        if (p.keys.has(Pickup.KEY_BLUE) || p.keys.has(Pickup.KEY_BLUE_SKULL)) out.push("\u{1F537}");
        if (p.keys.has(Pickup.KEY_YELLOW) || p.keys.has(Pickup.KEY_YELLOW_SKULL)) out.push("\u{1F538}");
        if (p.keys.has(Pickup.KEY_RED) || p.keys.has(Pickup.KEY_RED_SKULL)) out.push("\u{1F534}");
        return out.join(" ");
    }

    dispose(): void {
        this.root.remove();
        this.messageEl.remove();
        this.painEl.remove();
    }
}
