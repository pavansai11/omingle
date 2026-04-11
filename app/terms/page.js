import Link from 'next/link'
import SiteFooter from '@/components/site-footer'

export const metadata = {
  title: 'Terms of Service — HippiChat',
  description: 'Terms of Service for HippiChat.',
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center">
          <img src="/logo.svg" alt="HippiChat" className="h-12 sm:h-14 w-auto" />
        </Link>
      </nav>
      <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
        <div className="rounded-3xl border border-white/10 bg-gray-950 p-6 sm:p-10 shadow-2xl">
          <h1 className="text-3xl font-bold sm:text-4xl">Terms of Service</h1>
          <p className="mt-3 text-sm text-gray-400">Effective Date: 11-04-2026 | Last Updated: 11-04-2026</p>

          <div className="mt-8 space-y-8 text-sm leading-7 text-gray-300">
            <section>
              <h2 className="text-lg font-semibold text-white">1. Acceptance of Terms</h2>
              <p className="mt-2">
                By accessing or using HippiChat (hippichat.com), you confirm that you are at least 18 years of age and
                agree to be bound by these Terms of Service. If you do not agree, do not use this platform. These Terms
                constitute a legally binding agreement between you and HippiChat, operated by Pavan Sai Reddy, India.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">2. Eligibility</h2>
              <p className="mt-2">
                You must be 18 years of age or older to use HippiChat. By using our service, you represent and warrant
                that you are at least 18 years old. HippiChat does not knowingly allow anyone under 18 to use the
                platform. If we discover a user is under 18, their access will be terminated immediately.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">3. Description of Service</h2>
              <p className="mt-2">
                HippiChat is a random video and text chat platform that connects users anonymously with strangers
                online. HippiChat acts as an intermediary platform under the Information Technology Act, 2000 and IT
                (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021. HippiChat does not initiate,
                moderate, or endorse any content shared between users in real time.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">4. Prohibited Content and Conduct</h2>
              <p className="mt-2">You agree NOT to use HippiChat to:</p>
              <ul className="mt-3 list-disc space-y-1 pl-5">
                <li>Display, share, or transmit nudity, sexual content, or any adult material</li>
                <li>Share child sexual abuse material (CSAM) — this is a criminal offence under POCSO Act 2012 and will be reported to authorities</li>
                <li>Harass, threaten, abuse, stalk, or harm other users</li>
                <li>Share personal information of others without consent</li>
                <li>Impersonate any person or entity</li>
                <li>Spread hate speech, discriminatory content, or content inciting violence</li>
                <li>Violate any applicable Indian or international law</li>
                <li>Use automated bots, scripts, or tools to interact with the platform</li>
                <li>Record, screenshot, or distribute chats without the other person's consent</li>
                <li>Share content that infringes intellectual property rights of others</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">5. Disclaimer of Liability — User Generated Content</h2>
              <p className="mt-2">
                HippiChat is an intermediary platform as defined under Section 2(w) of the Information Technology Act,
                2000. HippiChat does not create, control, or endorse any content shared by users. HippiChat shall not
                be liable for any content transmitted through the platform by users, subject to compliance with IT Rules
                2021. HippiChat shall take action on reported content within the timelines prescribed by applicable law.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">6. Privacy</h2>
              <p className="mt-2">Your use of HippiChat is also governed by our Privacy Policy, which is incorporated into these Terms by reference. Please review our Privacy Policy at hippichat.com/privacy.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">7. Intellectual Property</h2>
              <p className="mt-2">The HippiChat name, logo, design, and underlying technology are the property of Pavan Sai Reddy. You may not copy, reproduce, or redistribute any part of HippiChat without prior written permission.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">8. Termination</h2>
              <p className="mt-2">We reserve the right to terminate or suspend your access to HippiChat at any time, without notice, for conduct that we believe violates these Terms or is harmful to other users, us, third parties, or for any other reason at our sole discretion.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">9. Limitation of Liability</h2>
              <p className="mt-2">To the maximum extent permitted by law, HippiChat and its operator Pavan Sai Reddy shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the platform. The platform is provided "as is" without warranty of any kind.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">10. Governing Law and Jurisdiction</h2>
              <p className="mt-2">These Terms are governed by the laws of India. Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of the courts in Telangana, India.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">11. Changes to Terms</h2>
              <p className="mt-2">We may update these Terms from time to time. Continued use of HippiChat after any changes constitutes acceptance of the updated Terms. We will notify users of material changes by updating the "Last Updated" date above.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">12. Contact</h2>
              <p className="mt-2">
                For any questions regarding these Terms, contact our Grievance Officer: Pavan Sai Reddy, Email:{' '}
                <a href="mailto:grievance@hippichat.com" className="text-[#F5C842] hover:underline">grievance@hippichat.com</a>
              </p>
            </section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}