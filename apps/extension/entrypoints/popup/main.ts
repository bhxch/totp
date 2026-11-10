import { createApp } from 'vue'
import { createAppI18n } from '@totp/ui'
import { store } from '../../src/store'
import { installBackgroundCloudFetch } from '../../src/cloudFetchProxy'
import { installExtensionTimeSync } from '../../src/timeSyncInstall'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'

installBackgroundCloudFetch()
installExtensionTimeSync(store) // 时间源单例装配（mount 前安装；ui 单例自带装载闸门，顺序无敏感性）
createApp(App).use(createAppI18n(store)).mount('#app')
