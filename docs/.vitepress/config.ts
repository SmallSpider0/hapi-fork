import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'HAPI',
  description: 'Control your AI agents from anywhere',
  base: '/docs/',

  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Quick Start', link: '/guide/quick-start' },
      { text: 'App', link: 'https://app.hapi.run', target: '_blank' }
    ],

    sidebar: [
      { text: 'Quick Start', link: '/guide/quick-start' },
      { text: 'Installation', link: '/guide/installation' },
      { text: 'PWA', link: '/guide/pwa' },
      { text: 'How it Works', link: '/guide/how-it-works' },
      { text: 'Cursor Agent', link: '/guide/cursor' },
      { text: 'Voice Assistant', link: '/guide/voice-assistant' },
      {
        text: 'Plugin API',
        items: [
          { text: 'Overview', link: '/reference/plugin-api/' },
          { text: 'Tutorials', link: '/reference/plugin-api/tutorial' },
          { text: 'Hub Notification Tutorial', link: '/reference/plugin-api/tutorial-hub-notification' },
          { text: 'Runner Environment Tutorial', link: '/reference/plugin-api/tutorial-runner-env' },
          { text: 'Web Descriptor Tutorial', link: '/reference/plugin-api/tutorial-web-descriptor' },
          { text: 'Manifest', link: '/reference/plugin-api/manifest' },
          { text: 'Runtime SDK', link: '/reference/plugin-api/runtime-sdk' },
          { text: 'Hub Runtime', link: '/reference/plugin-api/hub-runtime' },
          { text: 'Runner Runtime', link: '/reference/plugin-api/runner-runtime' },
          { text: 'Web Descriptors', link: '/reference/plugin-api/web-descriptors' },
          { text: 'Agent Extensions', link: '/reference/plugin-api/agent-extensions' },
          { text: 'Admin REST API', link: '/reference/plugin-api/admin-rest-api' },
          { text: 'Schemas', link: '/reference/plugin-api/schemas' }
        ]
      },
      { text: 'Why HAPI', link: '/guide/why-hapi' },
      { text: 'FAQ', link: '/guide/faq' }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/tiann/hapi' }
    ],

    footer: {
      message: 'Released under the LGPL-3.0 License.',
      copyright: 'Copyright © 2024-present'
    },

    search: {
      provider: 'local'
    }
  },

  vite: {
    server: {
      allowedHosts: true
    }
  }
})
