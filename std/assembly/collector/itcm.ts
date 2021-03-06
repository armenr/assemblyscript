/**
 * Incremental Tri-Color-Marking Garbage Collector.
 *
 * @module std/assembly/collector/itcm
 *//***/

// Largely based on the Bach Le's μgc, see: https://github.com/bullno1/ugc

const TRACE = false;

import {
  AL_MASK,
  MAX_SIZE_32
} from "../internal/allocator";

import {
  iterateRoots
} from "../gc";

/** Collector states. */
const enum State {
  /** Not yet initialized. */
  INIT = 0,
  /** Currently transitioning from SWEEP to MARK state. */
  IDLE = 1,
  /** Currently marking reachable objects. */
  MARK = 2,
  /** Currently sweeping unreachable objects. */
  SWEEP = 3
}

/** Current collector state. */
var state = State.INIT;
/** Current white color value. */
var white = 0;

// From and to spaces
var from: ManagedObjectSet;
var to: ManagedObjectSet;
var iter: ManagedObject;

// ╒═══════════════ Managed object layout (32-bit) ════════════════╕
//    3                   2                   1
//  1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0 9 8 7 6 5 4 3 2 1 0  bits
// ├─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┼─┴─┴─┤      ┐
// │                              next                       │  F  │ ◄─┐ = nextWithFlags
// ├─────────────────────────────────────────────────────────┴─────┤   │ usize
// │                              prev                             │ ◄─┘
// ╞═══════════════════════════════════════════════════════════════╡ SIZE ┘
// │                          ... data ...                         │
// └───────────────────────────────────────────────────────────────┘
// F: flags

/** Represents a managed object in memory, consisting of a header followed by the object's data. */
@unmanaged
class ManagedObject {

  /** Pointer to the next object with color flags stored in the alignment bits. */
  nextWithColor: usize;

  /** Pointer to the previous object. */
  prev: ManagedObject;

  /** Visitor function called with the payload reference. */
  visitFn: (ref: usize) => void;

  /** Size of a managed object after alignment. */
  static readonly SIZE: usize = (offsetof<ManagedObject>() + AL_MASK) & ~AL_MASK;

  /** Gets the pointer to the next object in the list. */
  get next(): ManagedObject {
    return changetype<ManagedObject>(this.nextWithColor & ~3);
  }

  /** Sets the pointer to the next object in the list. */
  set next(obj: ManagedObject) {
    this.nextWithColor = changetype<usize>(obj) | (this.nextWithColor & 3);
  }

  /** Gets this object's color. */
  get color(): i32 {
    return this.nextWithColor & 3;
  }

  /** Sets this object's color. */
  set color(color: i32) {
    this.nextWithColor = (this.nextWithColor & ~3) | color;
  }

  /** Unlinks this object from its list. */
  unlink(): void {
    var next = this.next;
    var prev = this.prev;
    if (TRACE) trace("   unlink", 3, objToRef(prev), objToRef(this), objToRef(next));
    next.prev = prev;
    prev.next = next;
  }

  /** Marks this object as gray, that is reachable with unscanned children. */
  makeGray(): void {
    if (TRACE) trace("   makeGray", 1, objToRef(this));
    const gray = 2;
    if (this == iter) iter = this.prev;
    this.unlink();
    to.push(this);
    this.nextWithColor = (this.nextWithColor & ~3) | gray;
  }
}

/** A set of managed objects. Used for the from and to spaces. */
@unmanaged
class ManagedObjectSet extends ManagedObject {

  /** Inserts an object. */
  push(obj: ManagedObject): void {
    var prev = this.prev;
    if (TRACE) trace("   push", 3, objToRef(prev), objToRef(obj), objToRef(this));
    obj.next = this;
    obj.prev = prev;
    prev.next = obj;
    this.prev = obj;
  }

  /** Clears this list. */
  clear(): void {
    if (TRACE) trace("   clear", 1, objToRef(this));
    this.nextWithColor = changetype<usize>(this);
    this.prev = this;
  }
}

/** Performs a single step according to the current state. */
function step(): void {
  var obj: ManagedObject;
  switch (state) {
    case State.INIT: {
      if (TRACE) trace("gc~step/INIT");
      from = changetype<ManagedObjectSet>(memory.allocate(ManagedObject.SIZE));
      from.visitFn = changetype<(ref: usize) => void>(<u32>-1); // would error
      from.clear();
      to = changetype<ManagedObjectSet>(memory.allocate(ManagedObject.SIZE));
      to.visitFn = changetype<(ref: usize) => void>(<u32>-1); // would error
      to.clear();
      iter = to;
      state = State.IDLE;
      if (TRACE) trace("gc~state = IDLE");
      // fall-through
    }
    case State.IDLE: {
      if (TRACE) trace("gc~step/IDLE");
      iterateRoots(__gc_mark);
      state = State.MARK;
      if (TRACE) trace("gc~state = MARK");
      break;
    }
    case State.MARK: {
      obj = iter.next;
      if (obj !== to) {
        if (TRACE) trace("gc~step/MARK iterate", 1, objToRef(obj));
        iter = obj;
        obj.color = <i32>!white;
        obj.visitFn(objToRef(obj));
      } else {
        if (TRACE) trace("gc~step/MARK finish");
        iterateRoots(__gc_mark);
        obj = iter.next;
        if (obj === to) {
          let prevFrom = from;
          from = to;
          to = prevFrom;
          white = <i32>!white;
          iter = prevFrom.next;
          state = State.SWEEP;
          if (TRACE) trace("gc~state = SWEEP");
        }
      }
      break;
    }
    case State.SWEEP: {
      obj = iter;
      if (obj !== to) {
        if (TRACE) trace("gc~step/SWEEP free", 1, objToRef(obj));
        iter = obj.next;
        memory.free(changetype<usize>(obj));
      } else {
        if (TRACE) trace("gc~step/SWEEP finish");
        to.clear();
        state = State.IDLE;
        if (TRACE) trace("gc~state = IDLE");
      }
      break;
    }
  }
}

@inline function refToObj(ref: usize): ManagedObject {
  return changetype<ManagedObject>(ref - ManagedObject.SIZE);
}

@inline function objToRef(obj: ManagedObject): usize {
  return changetype<usize>(obj) + ManagedObject.SIZE;
}

// Garbage collector interface

@global export function __gc_allocate(
  size: usize,
  visitFn: (ref: usize) => void
): usize {
  if (TRACE) trace("gc.allocate", 1, size);
  if (size > MAX_SIZE_32 - ManagedObject.SIZE) unreachable();
  step(); // also makes sure it's initialized
  var obj = changetype<ManagedObject>(memory.allocate(ManagedObject.SIZE + size));
  obj.visitFn = visitFn;
  obj.color = white;
  from.push(obj);
  return objToRef(obj);
}

@global export function __gc_link(parentRef: usize, childRef: usize): void {
  if (TRACE) trace("gc.link", 2, parentRef, childRef);
  var parent = refToObj(parentRef);
  if (parent.color == <i32>!white && refToObj(childRef).color == white) parent.makeGray();
}

@global export function __gc_mark(ref: usize): void {
  if (TRACE) trace("gc.mark", 1, ref);
  if (ref) {
    let obj = refToObj(ref);
    if (obj.color == white) obj.makeGray();
  }
}

@global export function __gc_collect(): void {
  if (TRACE) trace("gc.collect");
  // begin collecting if not yet collecting
  switch (state) {
    case State.INIT:
    case State.IDLE: step();
  }
  // finish the cycle
  while (state != State.IDLE) step();
}
