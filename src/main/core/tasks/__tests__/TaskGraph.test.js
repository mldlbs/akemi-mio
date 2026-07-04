import { describe, it, expect } from 'vitest';
import { TaskGraph } from '../TaskGraph';
describe('TaskGraph', () => {
    it('should add and remove nodes', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: [], produces: [] });
        expect(g.size).toBe(1);
        g.removeNode('a');
        expect(g.size).toBe(0);
    });
    it('should add edges via dependsOn', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: [], produces: ['x'] });
        g.addNode('b', { dependsOn: ['a'], blocks: [], produces: ['y'] });
        expect(g.getDependents('a')).toEqual(['b']);
        expect(g.getBlockedBy('b')).toEqual(['a']);
    });
    it('should find root nodes', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: [], produces: [] });
        g.addNode('b', { dependsOn: ['a'], blocks: [], produces: [] });
        g.addNode('c', { dependsOn: [], blocks: [], produces: [] });
        const roots = g.getRootNodes();
        expect(roots.sort()).toEqual(['a', 'c']);
    });
    it('should compute subgraph', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: [], produces: [] });
        g.addNode('b', { dependsOn: ['a'], blocks: [], produces: [] });
        g.addNode('c', { dependsOn: ['b'], blocks: [], produces: [] });
        g.addNode('d', { dependsOn: [], blocks: [], produces: [] });
        const sub = g.getSubgraph('a');
        expect(sub.sort()).toEqual(['a', 'b', 'c']);
    });
    it('should topological sort', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: [], produces: [] });
        g.addNode('b', { dependsOn: ['a'], blocks: [], produces: [] });
        g.addNode('c', { dependsOn: ['b'], blocks: [], produces: [] });
        const sorted = g.topologicalSort();
        expect(sorted).toEqual(['a', 'b', 'c']);
    });
    it('should detect cycles and return empty sort', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: ['c'], blocks: ['b'], produces: [] });
        g.addNode('b', { dependsOn: ['a'], blocks: ['c'], produces: [] });
        g.addNode('c', { dependsOn: ['b'], blocks: [], produces: [] });
        expect(g.topologicalSort()).toEqual([]);
    });
    it('should detect a cycle path', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: ['c'], blocks: ['b'], produces: [] });
        g.addNode('b', { dependsOn: ['a'], blocks: ['c'], produces: [] });
        g.addNode('c', { dependsOn: ['b'], blocks: [], produces: [] });
        const cycle = g.detectCycle();
        expect(cycle).not.toBeNull();
        expect(cycle.length).toBeGreaterThanOrEqual(3);
    });
    it('should return null for acyclic graph', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: ['b'], produces: [] });
        g.addNode('b', { dependsOn: ['a'], blocks: ['c'], produces: [] });
        g.addNode('c', { dependsOn: ['b'], blocks: [], produces: [] });
        expect(g.detectCycle()).toBeNull();
    });
    it('should handle empty graph', () => {
        const g = new TaskGraph();
        expect(g.size).toBe(0);
        expect(g.topologicalSort()).toEqual([]);
        expect(g.detectCycle()).toBeNull();
    });
    it('should handle single node', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: [], produces: [] });
        expect(g.topologicalSort()).toEqual(['a']);
        expect(g.detectCycle()).toBeNull();
    });
    it('should get all nodes and edges', () => {
        const g = new TaskGraph();
        g.addNode('a', { dependsOn: [], blocks: [], produces: [] });
        g.addNode('b', { dependsOn: ['a'], blocks: [], produces: [] });
        expect(g.getAllNodes().sort()).toEqual(['a', 'b']);
        expect(g.getEdges()).toEqual([{ from: 'a', to: 'b' }]);
    });
});
