import type { GraphEdge, GraphNode, ItemType } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import { call, useLive } from '../lib/api.ts';
import { TYPE_LABELS } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Empty } from '../ui.tsx';

const TYPE_COLORS: Record<ItemType, string> = {
  note: '#8fa6bd',
  bookmark: '#2fa3ad',
  file: '#7fae8e',
  image: '#c58fb4',
  task: '#d4b25a',
  decision: '#8f96d8',
};
const TAG_COLOR = '#8a979e';

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

interface Sim {
  nodes: SimNode[];
  edges: { a: SimNode; b: SimNode; kind: GraphEdge['kind'] }[];
  alpha: number;
  view: { x: number; y: number; k: number };
}

const radius = (node: SimNode) => (node.kind === 'project' ? 10 : node.kind === 'tag' ? 5 : 4 + Math.min(node.degree, 8) * 0.5);
const color = (node: SimNode) => (node.kind === 'tag' ? TAG_COLOR : node.kind === 'project' ? '' : TYPE_COLORS[node.type ?? 'note']);

function step(sim: Sim): void {
  const { nodes, edges } = sim;
  const alpha = sim.alpha;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = Math.max(dx * dx + dy * dy, 30);
      const force = (1600 * alpha) / d2;
      const fx = dx * force / Math.sqrt(d2);
      const fy = dy * force / Math.sqrt(d2);
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }
  for (const { a, b, kind } of edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const length = kind === 'in_project' ? 90 : kind === 'tagged' ? 60 : 50;
    const force = ((d - length) / d) * 0.05 * alpha;
    a.vx += dx * force;
    a.vy += dy * force;
    b.vx -= dx * force;
    b.vy -= dy * force;
  }
  for (const node of nodes) {
    node.vx -= node.x * 0.006 * alpha;
    node.vy -= node.y * 0.006 * alpha;
    node.vx *= 0.6;
    node.vy *= 0.6;
    node.x += node.vx;
    node.y += node.vy;
  }
  sim.alpha *= 0.985;
}

export function GraphView() {
  const { projects, openItem, go } = useApp();
  const [project, setProject] = useState('');
  const graph = useLive(() => call('graph.get', project || undefined), [project]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sim = useRef<Sim>({ nodes: [], edges: [], alpha: 1, view: { x: 0, y: 0, k: 1 } });
  const hover = useRef<SimNode | null>(null);
  const frame = useRef(0);
  const [, setTick] = useState(0);

  const draw = () => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue('--text').trim();
    const muted = css.getPropertyValue('--text-3').trim();
    const line = css.getPropertyValue('--border-strong').trim();
    const ember = css.getPropertyValue('--ember').trim();
    const dpr = window.devicePixelRatio || 1;
    const { view, nodes, edges } = sim.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * (el.clientWidth / 2 + view.x), dpr * (el.clientHeight / 2 + view.y));
    const focus = hover.current;
    ctx.lineWidth = 1 / view.k;
    for (const { a, b } of edges) {
      ctx.strokeStyle = line;
      ctx.globalAlpha = focus && (a === focus || b === focus) ? 1 : 0.55;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const node of nodes) {
      const r = radius(node);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      if (node.kind === 'project') {
        ctx.fillStyle = text;
        ctx.fill();
        ctx.lineWidth = 3 / view.k;
        ctx.strokeStyle = ember;
        ctx.stroke();
        ctx.lineWidth = 1 / view.k;
      } else {
        ctx.fillStyle = color(node);
        ctx.fill();
      }
      if (node === focus) {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = ember;
        ctx.stroke();
        ctx.lineWidth = 1 / view.k;
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Item labels crowd a big graph, so they appear as you zoom in; small graphs show them all.
    const itemLabels = nodes.length <= 25 || view.k >= 2.2;
    for (const node of nodes) {
      const always = node.kind === 'project';
      const visible = always || node === focus || (node.kind === 'tag' ? view.k >= 1.2 || itemLabels : itemLabels);
      if (!visible) continue;
      ctx.font = `${always ? 600 : 400} ${(always ? 12 : 11) / view.k}px system-ui, sans-serif`;
      ctx.fillStyle = node === focus || always ? text : muted;
      const label = node.label.length > 48 ? `${node.label.slice(0, 47)}…` : node.label;
      ctx.fillText(label, node.x, node.y + radius(node) + 3 / view.k);
    }
  };

  /** Zooms so the whole layout fills the canvas. Follows a fresh layout until the user pans or zooms. */
  const fit = () => {
    const el = canvas.current;
    const { nodes, view } = sim.current;
    if (!el || nodes.length === 0) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(2.5, 0.8 * Math.min(el.clientWidth / Math.max(maxX - minX, 1), el.clientHeight / Math.max(maxY - minY, 1)));
    view.k = Math.max(0.25, k);
    view.x = -((minX + maxX) / 2) * view.k;
    view.y = -((minY + maxY) / 2) * view.k;
  };

  const autoFit = useRef(true);
  const animate = () => {
    cancelAnimationFrame(frame.current);
    const loop = () => {
      step(sim.current);
      if (autoFit.current) fit();
      draw();
      if (sim.current.alpha > 0.02) frame.current = requestAnimationFrame(loop);
    };
    frame.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const data = graph.data;
    if (!data) return;
    // Keep existing nodes where they are, so a live refresh doesn't scatter the layout.
    const previous = new Map(sim.current.nodes.map((n) => [n.id, n]));
    const nodes: SimNode[] = data.nodes.map((node, i) => {
      const old = previous.get(node.id);
      const angle = i * 2.4;
      const spread = 30 + Math.sqrt(i) * 25;
      return { ...node, x: old?.x ?? Math.cos(angle) * spread, y: old?.y ?? Math.sin(angle) * spread, vx: 0, vy: 0, degree: 0 };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = data.edges.flatMap((edge) => {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) return [];
      a.degree += 1;
      b.degree += 1;
      return [{ a, b, kind: edge.kind }];
    });
    const fresh = !data.nodes.some((node) => previous.has(node.id));
    sim.current = { nodes, edges, alpha: fresh ? 1 : 0.4, view: sim.current.view };
    if (fresh) autoFit.current = true;
    animate();
    setTick((t) => t + 1);
    return () => cancelAnimationFrame(frame.current);
  }, [graph.data]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      el.width = el.clientWidth * dpr;
      el.height = el.clientHeight * dpr;
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', draw);
    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', draw);
    };
  }, []);

  const toWorld = (event: React.MouseEvent | React.WheelEvent) => {
    const el = canvas.current!;
    const rect = el.getBoundingClientRect();
    const { view } = sim.current;
    return {
      x: (event.clientX - rect.left - el.clientWidth / 2 - view.x) / view.k,
      y: (event.clientY - rect.top - el.clientHeight / 2 - view.y) / view.k,
    };
  };

  const nodeAt = (event: React.MouseEvent) => {
    const p = toWorld(event);
    let best: SimNode | null = null;
    let bestDistance = Infinity;
    for (const node of sim.current.nodes) {
      const d = Math.hypot(node.x - p.x, node.y - p.y);
      if (d < radius(node) + 5 / sim.current.view.k && d < bestDistance) {
        best = node;
        bestDistance = d;
      }
    }
    return best;
  };

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const nodes = graph.data?.nodes ?? [];

  return (
    <div className="page graph-page">
      <header className="page-header">
        <h1>Graph</h1>
        <select aria-label="Project" value={project} onChange={(event) => setProject(event.target.value)}>
          <option value="">Whole library</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p className="subtitle">How recent items connect through projects, tags and relations. Drag to move around, scroll to zoom, click an item to open it.</p>
      </header>
      {graph.data && nodes.length === 0 && <Empty title="Nothing to draw yet">Save a few things and file them into projects or tag them.</Empty>}
      <div className="graph-wrap" hidden={nodes.length === 0}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Graph of ${nodes.length} nodes`}
          onMouseDown={(event) => {
            drag.current = { x: event.clientX, y: event.clientY, moved: false };
            autoFit.current = false;
          }}
          onMouseMove={(event) => {
            const d = drag.current;
            if (d) {
              const dx = event.clientX - d.x;
              const dy = event.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
              sim.current.view.x += dx;
              sim.current.view.y += dy;
              d.x = event.clientX;
              d.y = event.clientY;
              draw();
              return;
            }
            const found = nodeAt(event);
            if (found !== hover.current) {
              hover.current = found;
              canvas.current!.style.cursor = found && found.kind !== 'tag' ? 'pointer' : 'grab';
              canvas.current!.title = found?.label ?? '';
              draw();
            }
          }}
          onMouseUp={(event) => {
            const moved = drag.current?.moved;
            drag.current = null;
            if (moved) return;
            const found = nodeAt(event);
            if (found?.kind === 'item') openItem(found.id);
            else if (found?.kind === 'project') go({ view: 'project', id: found.id });
          }}
          onMouseLeave={() => {
            drag.current = null;
            hover.current = null;
            draw();
          }}
          onWheel={(event) => {
            autoFit.current = false;
            const view = sim.current.view;
            const before = toWorld(event);
            view.k = Math.min(4, Math.max(0.25, view.k * Math.exp(-event.deltaY * 0.0015)));
            const after = toWorld(event);
            view.x += (after.x - before.x) * view.k;
            view.y += (after.y - before.y) * view.k;
            draw();
          }}
        />
        <div className="graph-legend" aria-hidden="true">
          <span><i className="dot project" /> Project</span>
          {(Object.keys(TYPE_COLORS) as ItemType[]).map((type) => (
            <span key={type}><i className="dot" style={{ background: TYPE_COLORS[type] }} /> {TYPE_LABELS[type]}</span>
          ))}
          <span><i className="dot" style={{ background: TAG_COLOR }} /> Tag</span>
        </div>
      </div>
    </div>
  );
}
