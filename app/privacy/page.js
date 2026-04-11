import SiteFooter from '@/components/site-footer'

export const metadata = {
  title: 'Privacy Policy — HippiChat',
  description: 'Privacy Policy for HippiChat.',
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
        <div className="rounded-3xl border border-white/10 bg-gray-950 p-6 sm:p-10 shadow-2xl">
          <h1 className="text-3xl font-bold sm:text-4xl">Privacy Policy</h1>
          <p className="mt-3 text-sm text-gray-400">Effective Date: 11-04-2026 | Operator: Pavan Sai Reddy, India</p>

          <div className="mt-8 space-y-8 text-sm leading-7 text-gray-300">
            <p>
              This Privacy Policy explains how HippiChat (hippichat.com) collects, uses, and protects information when
              you use our platform. We are committed to protecting your privacy in accordance with the Digital Personal
              Data Protection Act, 2023 (DPDP Act) and the IT (Intermediary Guidelines) Rules, 2021.
            </p>

            <section>
              <h2 className="text-lg font-semibold text-white">1. Information We Collect</h2>
              <p className="mt-2 font-medium text-white">Automatically collected (technical data):</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>IP address (used for geographic matching, fraud prevention, and legal compliance)</li>
                <li>Browser type and version</li>
                <li>Device type (desktop/mobile)</li>
                <li>Session timestamps (when you started/ended a chat)</li>
                <li>Connection quality data (for improving video performance)</li>
              </ul>
              <p className="mt-4 font-medium text-white">If you create an account (optional):</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Email address (Google OAuth — we receive only what Google provides)</li>
                <li>Display name (if you choose to set one)</li>
                <li>Friends list (only users you explicitly add)</li>
              </ul>
              <p className="mt-4">What we do NOT collect: We do not record, store, or access the content of video or voice chats. Chats are peer-to-peer encrypted. We do not collect financial information.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">2. How We Use Your Information</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>To match you with other users for chat sessions</li>
                <li>To maintain platform security and prevent abuse</li>
                <li>To respond to reports and grievances</li>
                <li>To comply with legal obligations under Indian law</li>
                <li>To display relevant advertisements through our ad partners (see Section 5)</li>
                <li>To improve the platform's performance</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">3. Data Retention</h2>
              <p className="mt-2">Technical session data (IP, timestamps) is retained for 90 days for legal compliance purposes (as required by IT Rules 2021 for intermediaries). Account data is retained as long as your account is active. If you delete your account, your data is permanently deleted within 30 days. Report logs are retained for 1 year.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">4. Sharing of Information</h2>
              <p className="mt-2">We do not sell your personal data. We may share data with:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Ad networks (Adsterra, Monetag): These networks may place cookies and collect anonymised usage data for ad targeting. See their respective privacy policies for details.</li>
                <li>Government and law enforcement: We will provide information in response to valid legal orders from Indian courts or government authorities as required by IT Act 2000.</li>
                <li>Cloudflare: We use Cloudflare for TURN relay services (video routing). Cloudflare processes encrypted relay data only. See Cloudflare's privacy policy at cloudflare.com/privacypolicy.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">5. Cookies and Advertising</h2>
              <p className="mt-2">HippiChat uses cookies for: session management, age verification consent storage, and ad serving. Our ad partners (Adsterra, Monetag) may set third-party cookies for ad personalisation. You can disable cookies in your browser settings, which may affect platform functionality. We do not use cookies for tracking children or collecting sensitive personal data.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">6. Children's Privacy</h2>
              <p className="mt-2">HippiChat is strictly for users aged 18 and above. We do not knowingly collect personal data from individuals under 18. If we become aware that a user is under 18, their account and associated data will be deleted immediately. If you believe a child has used our platform, contact us at grievance@hippichat.com.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">7. Your Rights Under DPDP Act 2023</h2>
              <p className="mt-2">As a user in India, you have the right to:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Access a summary of personal data we hold about you</li>
                <li>Correct inaccurate personal data</li>
                <li>Erase your personal data (right to be forgotten)</li>
                <li>Withdraw consent for data processing</li>
                <li>Nominate a representative in case of death or incapacity</li>
              </ul>
              <p className="mt-4">To exercise any of these rights, email grievance@hippichat.com. We will respond within 15 days.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">8. Data Security</h2>
              <p className="mt-2">We implement industry-standard security measures including HTTPS encryption, secure WebRTC connections (DTLS-SRTP), and access controls on our servers. However, no internet transmission is 100% secure. In case of a data breach, we will notify affected users and the Data Protection Board of India within 72 hours as required by law.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">9. International Data Transfers</h2>
              <p className="mt-2">We use Cloudflare's global TURN network, which means your connection data may be routed through servers outside India. This is necessary for low-latency video connections. Cloudflare complies with international data protection standards. We ensure appropriate safeguards are in place for such transfers.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">10. Changes to This Policy</h2>
              <p className="mt-2">We may update this Privacy Policy periodically. We will notify users of significant changes by updating the "Effective Date" above. Continued use after changes constitutes acceptance.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">11. Contact and Grievance</h2>
              <p className="mt-2">
                For privacy concerns or to exercise your rights:<br />
                Grievance Officer: Pavan Sai Reddy<br />
                Email:{' '}
                <a href="mailto:grievance@hippichat.com" className="text-[#F5C842] hover:underline">grievance@hippichat.com</a>
                <br />
                Response time: Acknowledgement within 24 hours, resolution within 15 days.
              </p>
            </section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}