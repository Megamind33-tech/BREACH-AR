package com.viro.workcare

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import com.viro.workcare.ui.AppRoot
import com.viro.workcare.ui.Wc
import com.viro.workcare.ui.WorkCareTheme

class MainActivity : ComponentActivity() {
    private val vm: AppVm by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        vm.handleLink(intent?.data?.toString())
        vm.debugCleanRoot(intent)
        setContent {
            val dark = when (vm.themeMode) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
            WorkCareTheme(dark) {
                // System bars follow the theme: light icons on dark, dark icons on light.
                val view = LocalView.current
                SideEffect { val c = WindowCompat.getInsetsController(window, view); c.isAppearanceLightStatusBars = !dark; c.isAppearanceLightNavigationBars = !dark }
                AppRoot(vm)
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); vm.handleLink(intent.data?.toString()); vm.debugCleanRoot(intent) }
    override fun onStart() { super.onStart(); vm.readPhone() }
}
