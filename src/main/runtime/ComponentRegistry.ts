/**
 * ComponentRegistry — descriptor registry for CheckpointableComponent.
 *
 * Application-scoped. Holds descriptors (factories), NOT instances.
 * Restore creates isolated component instances per session.
 *
 * see docs/runtime-restore-architecture.md §2.1
 */

import type { ComponentDescriptor } from './CheckpointTypes'

export interface ComponentRegistry {
  /** Register a descriptor. Throws if id already registered. */
  register(descriptor: ComponentDescriptor): void
  /** Look up descriptor by id. Returns undefined if not found. */
  resolve(id: string): ComponentDescriptor | undefined
  /** List all registered descriptors. */
  list(): ComponentDescriptor[]
}

export class ComponentRegistryImpl implements ComponentRegistry {
  private descriptors = new Map<string, ComponentDescriptor>()

  register(descriptor: ComponentDescriptor): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`ComponentRegistry: duplicate registration for '${descriptor.id}'`)
    }
    this.descriptors.set(descriptor.id, descriptor)
  }

  resolve(id: string): ComponentDescriptor | undefined {
    return this.descriptors.get(id)
  }

  list(): ComponentDescriptor[] {
    return Array.from(this.descriptors.values())
  }
}
