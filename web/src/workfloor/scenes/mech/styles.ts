import { v9 } from './palette'

/** 状态样式沿用 v9；所有运动由宿主 tick 驱动，离屏也不会有 CSS 动画偷跑。 */
export function sceneStyles(prefix: string) {
  return `<style>
.wf-mech { font-family:ui-monospace,Consolas,monospace; }
.wf-mech .mech .part { --fo:1;--so:1;--dash:none;--ol:${v9.c0e121c}; }
.wf-mech .mech .part.off { --fo:var(--mech-ghost,.14);--so:.75;--ol:${v9.c3d6f96}; }
.wf-mech .mech .part.off .pl { fill:${v9.c4fc3ff}; }
.wf-mech .mech .part.build { --fo:.45;--ol:${v9.c4fc3ff}; }
.wf-mech .mech .part.pend { --fo:.45;--ol:${v9.cffb020}; }
.wf-mech .mech .part.block { --fo:.45;--ol:${v9.cff4d5a}; }
.wf-mech .mech .part.park { --fo:.3;--so:.75;--ol:${v9.c3d6f96}; }
.wf-mech .mech .pl { fill-opacity:var(--fo);stroke:var(--ol);stroke-opacity:var(--so);stroke-dasharray:var(--dash);stroke-width:1.1;stroke-linejoin:round;vector-effect:non-scaling-stroke; }
.wf-mech .mech .pl.main { stroke-width:2.2; }
.wf-mech .mech .cable { fill:none;stroke:${v9.c1b2030};stroke-width:3;stroke-opacity:var(--so);stroke-linecap:round;vector-effect:non-scaling-stroke; }
.wf-mech .mech .part.off .cable { stroke:${v9.c3d6f96}; }
.wf-mech .mech .ln { fill:none;stroke:${v9.c0e121c};stroke-opacity:calc(var(--so) * .75);stroke-width:1;vector-effect:non-scaling-stroke;stroke-linecap:round; }
.wf-mech .mech .part:is(.off,.build,.pend,.block,.park) .ln { stroke:var(--ol);stroke-opacity:.35; }
.wf-mech .mech .hi { fill:${v9.cfff};fill-opacity:calc(var(--fo) * .28);stroke:none; }
.wf-mech .mech .sh { fill:${v9.c000};fill-opacity:calc(var(--fo) * .32);stroke:none; }
.wf-mech .mech .riv { fill:${v9.c0e121c};fill-opacity:calc(var(--fo) * .8);stroke:none; }
.wf-mech .mech .glow { fill:var(--gl,${v9.c5be3ff});stroke:none;filter:url(#fglow); }
.wf-mech .mech [data-part="chest"] .glow { fill:var(--wf-project,${v9.c5be3ff}); }
.wf-mech .mech .part:is(.off,.build,.pend,.block,.park) .glow { fill-opacity:.15;filter:none; }
.wf-mech .mech .decal { font-family:ui-monospace,Consolas,monospace;font-weight:700;fill:${v9.cf2f4f8};fill-opacity:calc(var(--fo) * .85);letter-spacing:.06em; }
.wf-mech .mech .part:is(.off,.build,.park) .decal { fill-opacity:0; }
.wf-mech .mech .thr { display:none; }
.wf-mech .mech .eline { stroke:${v9.c5be3ff};stroke-width:1.2;fill:none;opacity:0;vector-effect:non-scaling-stroke;filter:url(#fglow); }
.wf-mech .mech.powered .eline { opacity:.85; }
.wf-mech .scan { fill:none;stroke-width:2;filter:url(#fglow);opacity:.9; }
.wf-mech .seam { fill:none;stroke:${v9.cffe27a};stroke-width:2.2;stroke-linecap:round;filter:url(#fglow);vector-effect:non-scaling-stroke; }
.wf-mech [data-hologram] { opacity:var(--mech-hologram,1); }
.wf-mech [data-ceiling-beam], .wf-mech [data-gantry-beam] { opacity:var(--mech-lamps,1); }
.wf-mech .wash { fill:${v9.cff2d3d};pointer-events:none; }
.wf-mech .console { font-family:ui-monospace,Consolas,monospace;font-size:11px; }
.wf-mech .console .caption { font-size:9px;letter-spacing:.06em; }
.wf-mech .console .title { font-size:12px;letter-spacing:.03em; }
.wf-mech .console .screen-part { stroke-width:1.2;stroke-linejoin:round; }
.wf-mech .console .screen-part.off { opacity:.3; }
.wf-mech .scope-wave { fill:none;stroke-width:1.4;stroke-linejoin:round;stroke-dasharray:46 7; }
.wf-mech .scene-grain { opacity:.035;mix-blend-mode:overlay;pointer-events:none; }
</style>`.replaceAll('.wf-mech', `[data-mech-scene="${prefix}"]`)
}
