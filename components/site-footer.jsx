import Link from 'next/link'

export default function SiteFooter() {
  return (
    <footer className="relative z-20 border-t border-white/10 bg-gray-950 px-5 py-8 text-center text-xs leading-6 text-white/45">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <Link href="/terms" className="pointer-events-auto relative z-10 transition-colors hover:text-[#F5C842] text-white/70 underline-offset-4 hover:underline">
          Terms of Service
        </Link>
        <Link href="/privacy" className="pointer-events-auto relative z-10 transition-colors hover:text-[#F5C842] text-white/70 underline-offset-4 hover:underline">
          Privacy Policy
        </Link>
        <a href="mailto:grievance@hippichat.com" className="pointer-events-auto relative z-10 transition-colors hover:text-[#F5C842] text-white/70 underline-offset-4 hover:underline">
          Contact
        </a>
      </div>

      <div className="mx-auto my-4 inline-block rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left text-[11px] leading-5">
        <strong className="text-white/75">Grievance Officer (IT Rules 2021):</strong>
        <br />
        Name: Pavan Sai Reddy
        <br />
        Email:{' '}
        <a href="mailto:grievance@hippichat.com" className="text-[#F5C842] hover:underline">
          grievance@hippichat.com
        </a>
        <br />
        Complaints acknowledged within 24 hours · Resolved within 15 days
      </div>

      <div className="mx-auto max-w-5xl space-y-2">
        <p>
          HippiChat is an intermediary platform under Section 2(w) of the IT Act, 2000. All chats are anonymous and
          peer-to-peer encrypted. Users must be 18+. © 2026 HippiChat. Operated from India.
        </p>
        <p className="text-[10px] text-white/30">
          If you encounter illegal content, report it using the Report button during chat or email grievance@hippichat.com.
          For CSAM reports, we cooperate with relevant authorities and CERT-In.
        </p>
      </div>
    </footer>
  )
}