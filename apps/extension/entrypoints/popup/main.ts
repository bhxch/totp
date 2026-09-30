import { createApp } from 'vue'
import { createAppI18n } from '@totp/ui'
import { store } from '../../src/store'
import { installBackgroundCloudFetch } from '../../src/cloudFetchProxy'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'

installBackgroundCloudFetch()
createApp(App).use(createAppI18n(store)).mount('#app')
