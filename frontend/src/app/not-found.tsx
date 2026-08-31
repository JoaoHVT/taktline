'use client'
import Link from 'next/link'
import { NightScreen, NIGHT_BTN } from '@/components/NightScreen'

/**
 * 404 — a URL that resolves to nothing.
 *
 * The app has exactly two routes ('/' and '/auth'), so anything else here is a stale bookmark, a
 * hand-edited address or a link that outlived the page it pointed at. Next's built-in 404 is a
 * bare black-on-white line that looks like a different site entirely, which for an internal tool
 * reads as "the system is broken" rather than "that address is wrong". This is the SAME night
 * screen the app shows while the backend wakes up, with its own copy — one designed dead end
 * instead of a designed one plus a framework default.
 *
 * There is no 403 page and never was: authorization is enforced per REQUEST (require_auth on the
 * backend, PermissionsContext on the client), so a user without a role sees a disabled control or
 * an error toast — never a route that answers 403.
 */
export default function NotFound() {
  return (
    <NightScreen title="Página não encontrada">
      <div style={{ fontSize: 12.5, color: '#9AA6BF', lineHeight: 1.65 }}>
        O endereço acessado não existe ou foi movido.<br />
        Volte à página inicial para continuar.
      </div>
      <Link href="/" style={{ ...NIGHT_BTN, textDecoration: 'none' }}>
        Voltar ao início
      </Link>
    </NightScreen>
  )
}
