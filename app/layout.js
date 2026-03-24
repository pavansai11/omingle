import './globals.css'

export const metadata = {
  title: 'Omingle — Talk to Anyone, In Any Language',
  description: 'Random video & voice chat with real-time translation. Connect with strangers worldwide — no common language needed.',
  openGraph: {
    title: 'Omingle — Talk to Anyone, In Any Language',
    description: 'Random video & voice chat with real-time translation.',
    type: 'website',
  },
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{__html:'window.addEventListener("error",function(e){if(e.error instanceof DOMException&&e.error.name==="DataCloneError"&&e.message&&e.message.includes("PerformanceServerTiming")){e.stopImmediatePropagation();e.preventDefault()}},true);'}} />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </head>
      <body className="bg-gray-950 text-white antialiased min-h-screen">
        {children}
      </body>
    </html>
  )
}
