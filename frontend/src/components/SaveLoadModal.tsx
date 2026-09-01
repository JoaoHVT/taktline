/**
 * SaveLoadModal — session save / load panel.
 *
 * Saving now ENCRYPTS the session with a mandatory user password
 * (AES-256-GCM, see lib/sessionCrypto). Loading an encrypted file prompts for
 * that password; legacy (pre-encryption) plaintext files still load directly.
 */
'use client'
import { useRef, useState } from 'react'
import { X, Download, Upload, HardDrive, Lock, AlertTriangle, Loader2 } from 'lucide-react'
import { detectSessionFormat, MAX_SESSION_CHARS, MIN_PASSWORD_LEN } from '@/lib/sessionCrypto'
import { useFileDrop } from '@/lib/useFileDrop'

interface Props {
  /** Encrypt + download. Called with the filename (no extension) and the password. */
  onSave:  (filename: string, password: string) => Promise<void>
  /** Load a picked file. `password` is null for legacy plaintext files. Throws on failure. */
  onLoad:  (data: string, password: string | null) => Promise<void>
  onClose: () => void
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

type View = 'menu' | 'password-save' | 'password-load'

export function SaveLoadModal({ onSave, onLoad, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [filename, setFilename] = useState(`taktline_sessao_${todayStr()}`)
  const [view, setView] = useState<View>('menu')

  // Save state
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  // Load state
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [loadPw, setLoadPw] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const cleanFilename = filename.trim() || `taktline_sessao_${todayStr()}`
  const pwMismatch = pw2.length > 0 && pw1 !== pw2
  const canSave = pw1.length >= MIN_PASSWORD_LEN && pw1 === pw2 && !saving

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setSaveErr(null)
    try {
      await onSave(cleanFilename, pw1)
      onClose()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Falha ao salvar a sessão.')
      setSaving(false)
    }
  }

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (file) acceptFile(file)
  }

  function acceptFile(file: File) {
    if (file.size > MAX_SESSION_CHARS) {
      setLoadErr('Arquivo de sessão muito grande.')
      return
    }
    const reader = new FileReader()
    reader.onload = async ev => {
      const text = ev.target?.result
      if (typeof text !== 'string') return
      const fmt = detectSessionFormat(text)
      if (fmt === 'invalid') {
        setLoadErr('Arquivo de sessão inválido.')
        return
      }
      if (fmt === 'legacy') {
        // Old unencrypted session — load directly, no password.
        setLoading(true)
        setLoadErr(null)
        try {
          await onLoad(text, null)
          onClose()
        } catch (err) {
          setLoadErr(err instanceof Error ? err.message : 'Falha ao carregar a sessão.')
          setLoading(false)
        }
        return
      }
      // Encrypted — ask for the password.
      setPendingText(text)
      setLoadPw('')
      setLoadErr(null)
      setView('password-load')
    }
    reader.readAsText(file)
  }

  // Dropping a .json onto the "Carregar sessão" card runs the same acceptFile() path.
  const loadDrop = useFileDrop({
    onFile:   acceptFile,
    accept:   ['.json'],
    disabled: loading,
    onReject: setLoadErr,
  })

  async function handleDecrypt() {
    if (!pendingText || !loadPw || loading) return
    setLoading(true)
    setLoadErr(null)
    try {
      await onLoad(pendingText, loadPw)
      onClose()
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Falha ao carregar a sessão.')
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-2xl flex flex-col w-[92vw] max-w-sm overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#424242] shrink-0">
          <div className="flex items-center gap-2">
            <HardDrive size={15} className="text-white/80" />
            <span className="font-semibold text-sm text-white tracking-wide">Sessão</span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-white/20 transition-colors"
            title="Fechar"
          >
            <X size={15} className="text-white" />
          </button>
        </div>

        {view === 'password-load' ? (
          /* ── Password prompt for an encrypted file ─────────────────────── */
          <div className="flex flex-col gap-3 px-5 py-5">
            <div className="flex items-center gap-2 text-gray-700">
              <Lock size={15} className="text-[#1565C0]" />
              <span className="text-sm font-semibold">Sessão protegida por senha</span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Este arquivo está criptografado. Digite a senha usada ao salvá-lo.
            </p>
            <input
              type="password"
              autoFocus
              value={loadPw}
              onChange={e => { setLoadPw(e.target.value); setLoadErr(null) }}
              onKeyDown={e => { if (e.key === 'Enter') handleDecrypt() }}
              className="w-full px-3 py-2 text-xs text-gray-900 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1565C0]"
              placeholder="Senha da sessão"
              spellCheck={false}
            />
            {loadErr && (
              <div className="flex items-start gap-1.5 text-[11px] text-red-600">
                <AlertTriangle size={13} className="shrink-0 mt-px" />
                <span>{loadErr}</span>
              </div>
            )}
            <button
              onClick={handleDecrypt}
              disabled={!loadPw || loading}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#1565C0] text-white text-sm font-semibold hover:bg-[#0D47A1] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {loading ? 'Descriptografando…' : 'Carregar sessão'}
            </button>
            <button
              onClick={() => { setView('menu'); setPendingText(null); setLoadPw(''); setLoadErr(null) }}
              disabled={loading}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors self-center underline underline-offset-2 disabled:opacity-50"
            >
              Voltar
            </button>
          </div>
        ) : view === 'password-save' ? (
          /* ── Password dialog for saving (opens only after "Salvar sessão") ─ */
          <div className="flex flex-col gap-3 px-5 py-5">
            {/* The min-length rule lives here permanently instead of appearing as a
                validation line under the inputs — a conditional line made the dialog
                grow and shrink while typing. */}
            <div className="flex items-baseline gap-2 text-gray-700">
              <Lock size={15} className="self-center text-[#424242]" />
              <span className="text-sm font-semibold">Definir senha da sessão</span>
              <span className="text-[10px] text-gray-400">mín. {MIN_PASSWORD_LEN} caracteres</span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Crie uma senha para criptografar <span className="font-mono text-gray-700">{cleanFilename}.json</span>.
              Ela será exigida para abrir a sessão novamente.
            </p>
            <input
              type="password"
              autoFocus
              value={pw1}
              onChange={e => { setPw1(e.target.value); setSaveErr(null) }}
              className="w-full px-3 py-2 text-xs text-gray-900 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#424242]"
              placeholder={`Senha (mínimo ${MIN_PASSWORD_LEN} caracteres)`}
              spellCheck={false}
            />
            <input
              type="password"
              value={pw2}
              onChange={e => { setPw2(e.target.value); setSaveErr(null) }}
              onKeyDown={e => { if (e.key === 'Enter' && canSave) handleSave() }}
              className="w-full px-3 py-2 text-xs text-gray-900 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#424242]"
              placeholder="Confirmar senha"
              spellCheck={false}
            />
            {/* The mismatch warning is shown INSIDE this same label instead of on a line of its own,
                so no space is reserved for it and nothing shifts when it appears.
                HEIGHT IS INVARIANT BY CONSTRUCTION: both strings live in ONE grid cell, and the long
                info text is never unmounted — only hidden — so the cell always measures to it. Simply
                swapping the strings was not enough: they are 88 and 24 characters, so the info text
                wraps to two lines where the warning takes one and the box shrank as the user typed.
                Anchoring to the taller string also holds at any width, where it may wrap to three. */}
            <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2">
              <AlertTriangle size={13} className="shrink-0 mt-px text-amber-600" />
              <span className="grid text-[10px] text-amber-800 leading-snug">
                <span className="col-start-1 row-start-1" aria-hidden={pwMismatch} style={{ visibility: pwMismatch ? 'hidden' : 'visible' }}>
                  A senha não pode ser recuperada. Sem ela, o arquivo é ilegível — guarde-a com segurança.
                </span>
                {pwMismatch && (
                  <span className="col-start-1 row-start-1 font-semibold">As senhas não coincidem.</span>
                )}
              </span>
            </div>
            {saveErr && (
              <div className="flex items-start gap-1.5 text-[11px] text-red-600">
                <AlertTriangle size={13} className="shrink-0 mt-px" />
                <span>{saveErr}</span>
              </div>
            )}
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#424242] text-white text-sm font-semibold hover:bg-[#212121] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              {saving ? 'Criptografando…' : 'Salvar sessão'}
            </button>
            <button
              onClick={() => { setView('menu'); setPw1(''); setPw2(''); setSaveErr(null) }}
              disabled={saving}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors self-center underline underline-offset-2 disabled:opacity-50"
            >
              Voltar
            </button>
          </div>
        ) : (
          /* ── Main menu: save + load (no password shown here) ────────────── */
          <div className="flex flex-col gap-3 px-5 py-5">
            <p className="text-xs text-gray-500 leading-relaxed">
              Salve o estado atual da sessão em um arquivo <span className="font-mono text-gray-700">.json</span> criptografado
              e compactado, ou carregue uma sessão salva anteriormente.
            </p>

            {/* Filename */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                Nome do arquivo
              </label>
              <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden bg-white focus-within:ring-1 focus-within:ring-[#424242]">
                <input
                  type="text"
                  value={filename}
                  onChange={e => setFilename(e.target.value)}
                  className="flex-1 px-3 py-1.5 text-xs text-gray-900 bg-transparent focus:outline-none"
                  placeholder={`taktline_sessao_${todayStr()}`}
                  spellCheck={false}
                />
                <span className="pr-3 text-[10px] text-gray-400 font-mono shrink-0">.json</span>
              </div>
            </div>

            {/* Salvar → opens the dedicated password dialog (nothing saved yet) */}
            <button
              onClick={() => { setSaveErr(null); setView('password-save') }}
              className="group flex items-center gap-3 px-4 py-3.5 rounded-lg border-2 border-[#424242] bg-gray-50 hover:bg-gray-100 active:scale-[.98] transition-all text-left"
            >
              <div className="w-9 h-9 rounded-full bg-[#424242] flex items-center justify-center shrink-0 group-hover:bg-[#212121] transition-colors">
                <Download size={15} className="text-white" />
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-900">Salvar sessão</div>
                <div className="text-[11px] text-gray-500 leading-tight">
                  Exportar resultados criptografados e compactados (.json)
                </div>
              </div>
            </button>

            {/* Carregar */}
            <button
              onClick={() => fileRef.current?.click()}
              {...loadDrop.dropProps}
              className={`group flex items-center gap-3 px-4 py-3.5 rounded-lg border-2 active:scale-[.98] transition-all text-left ${
                loadDrop.dragging
                  ? 'border-[#0D47A1] bg-blue-100 border-dashed'
                  : 'border-[#1565C0] bg-blue-50 hover:bg-blue-100'}`}
            >
              <div className="w-9 h-9 rounded-full bg-[#1565C0] flex items-center justify-center shrink-0 group-hover:bg-[#0D47A1] transition-colors">
                <Upload size={15} className="text-white" />
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-900">
                  {loadDrop.dragging ? 'Solte o arquivo aqui' : 'Carregar sessão'}
                </div>
                <div className="text-[11px] text-gray-500 leading-tight">
                  Arraste o .json aqui ou clique para selecionar
                </div>
              </div>
            </button>

            {loadErr && (
              <div className="flex items-start gap-1.5 text-[11px] text-red-600">
                <AlertTriangle size={13} className="shrink-0 mt-px" />
                <span>{loadErr}</span>
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleFilePicked}
            />

            {/* Cancel */}
            <button
              onClick={onClose}
              className="mt-1 text-xs text-gray-400 hover:text-gray-600 transition-colors self-center underline underline-offset-2"
            >
              Cancelar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
