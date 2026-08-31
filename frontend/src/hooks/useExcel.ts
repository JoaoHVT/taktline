import { useState, useCallback } from 'react'
import {
  uploadExcel,
  loadExcelPreview,
  type ExcelData,
  type ExcelFilters,
} from '@/lib/api'

export function useExcel() {
  const [data,    setData]    = useState<ExcelData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const upload = useCallback(async (file: File, filters?: ExcelFilters) => {
    setLoading(true)
    setError(null)
    try {
      const result = await uploadExcel(file, filters)
      setData(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPreview = useCallback(async (filters?: ExcelFilters) => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadExcelPreview(filters)
      setData(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
  }, [])

  return { data, loading, error, upload, loadPreview, reset }
}
