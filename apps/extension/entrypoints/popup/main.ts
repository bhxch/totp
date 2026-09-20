import { createApp } from 'vue'
import { createAppI18n } from '@totp/ui'
import { store } from '../../src/store'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'

createApp(App).use(createAppI18n(store)).mount('#app')
