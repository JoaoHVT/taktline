'use client'
/**
 * useFileDrop — drag & drop for the existing file pickers.
 *
 * Every drop zone in the app funnels the dropped file into the SAME handler the
 * "choose a file" button already uses, so validation, upload and progress paths are
 * untouched: dropping is just another way to pick the file.
 *
 * `dragging` drives the visual highlight. The enter/leave counter is what makes that
 * highlight stable — `dragleave` also fires when the pointer crosses into a CHILD of
 * the zone, so a naive boolean flickers off mid-drag.
 */
import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { UPLOAD_MAX_BYTES, oversizeMessage } from './uploadLimits'

interface Options {
  /** Receives the dropped file — wire this to the same function the picker calls. */
  onFile: (file: File) => void
  /** Opt-in: receives EVERY dropped file instead of just the first. Zones that legitimately
   *  take a set (e.g. a pair of sheets arriving as two workbooks) use this — without it a
   *  two-file drop silently loses one, which reads as "the app ignored my file". */
  onFiles?: (files: File[]) => void
  /** Allowed lowercase extensions, e.g. ['.xlsx', '.xls']. Omit to accept anything. */
  accept?: string[]
  /**
   * Per-file size ceiling. Defaults to the app-wide 40 MB and is checked on EVERY zone —
   * a drop zone with no limit is the one path by which a 300 MB workbook reaches `XLSX.read`.
   * Pass a smaller number to tighten it; there is deliberately no way to switch it off.
   */
  maxBytes?: number
  /** When true, drops are ignored (upload in flight, read-only, …). */
  disabled?: boolean
  /** Called instead of `onFile` when the extension is not allowed or the file is too large. */
  onReject?: (message: string) => void
}

export interface FileDropZone {
  /** True while a drag is hovering this zone — use it to highlight the border. */
  dragging: boolean
  /** Spread onto the drop target element. */
  dropProps: {
    onDragEnter: (e: DragEvent<HTMLElement>) => void
    onDragOver:  (e: DragEvent<HTMLElement>) => void
    onDragLeave: (e: DragEvent<HTMLElement>) => void
    onDrop:      (e: DragEvent<HTMLElement>) => void
  }
}

/** True when the drag payload actually carries files (not selected text, a link, …). */
function hasFiles(e: DragEvent<HTMLElement>): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return Array.from(types).includes('Files')
}

export function useFileDrop({
  onFile, onFiles, accept, maxBytes = UPLOAD_MAX_BYTES, disabled, onReject,
}: Options): FileDropZone {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const reset = useCallback(() => { depth.current = 0; setDragging(false) }, [])

  const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    if (disabled || !hasFiles(e)) return
    e.preventDefault(); e.stopPropagation()
    depth.current += 1
    setDragging(true)
  }, [disabled])

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (disabled || !hasFiles(e)) return
    // Required: without preventDefault on dragover the browser opens the file itself.
    e.preventDefault(); e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    if (!dragging) setDragging(true)
  }, [disabled, dragging])

  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    if (disabled) return
    e.preventDefault(); e.stopPropagation()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [disabled])

  const onDrop = useCallback((e: DragEvent<HTMLElement>) => {
    if (disabled) return
    e.preventDefault(); e.stopPropagation()
    reset()
    const dropped = Array.from(e.dataTransfer?.files ?? [])
    if (!dropped.length) return

    const named = accept && accept.length > 0
      ? dropped.filter(f => accept.some(ext => f.name.toLowerCase().endsWith(ext)))
      : dropped
    if (named.length < dropped.length) {
      onReject?.(`Apenas arquivos ${accept!.join(' ou ')} são aceitos.`)
      if (!named.length) return
    }

    // SIZE IS CHECKED AFTER THE EXTENSION, and reported per file. A multi-file drop keeps the
    // files that fit rather than failing whole: the zones that take a set (a pair of sheets,
    // base + Pegging) would otherwise lose a valid workbook because its partner was too big.
    const ok = named.filter(f => f.size <= maxBytes)
    const tooBig = named.filter(f => f.size > maxBytes)
    if (tooBig.length) {
      onReject?.(tooBig.map(f => oversizeMessage(f)).join('\n'))
      if (!ok.length) return
    }

    if (onFiles) onFiles(ok)
    else onFile(ok[0])
  }, [disabled, accept, maxBytes, onFile, onFiles, onReject, reset])

  return { dragging, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
