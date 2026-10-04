package com.viro.workcare.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.viro.workcare.AppVm

private data class Tab(val route: String, val label: String, val icon: ImageVector)
private val tabs = listOf(Tab(R.HOME, "Home", WcIcons.Home), Tab(R.CHECK, "Scan", WcIcons.Check), Tab(R.CLEAN, "Clean", WcIcons.Clean), Tab(R.RESCUE, "Fix", WcIcons.Fix), Tab(R.YOU, "You", WcIcons.You))

@Composable fun AppRoot(vm: AppVm) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val start = if (!vm.onboarded) R.ONBOARDING else R.HOME
    fun go(r: String) { nav.navigate(r) { launchSingleTop = true } }
    fun tab(r: String) { nav.navigate(r) { popUpTo(nav.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true } }
    fun back() { if (!nav.popBackStack()) tab(R.HOME) }
    // Leaving a finished check goes back to where it began. A tab switch would restore the saved stack, including this finished page.
    fun finishCheck() { if (!nav.popBackStack(R.CHECK, false) && !nav.popBackStack(R.HOME, false)) tab(R.HOME) }
    LaunchedEffect(vm.pendingOffer) { if (vm.pendingOffer != null && vm.onboarded) go(R.PAIR) }

    Column(Modifier.fillMaxSize().background(Wc.colors.bg)) {
        Box(Modifier.weight(1f)) {
            NavHost(nav, startDestination = start) {
                composable(R.ONBOARDING) { OnboardingScreen { nav.navigate(R.FIRST) { popUpTo(R.ONBOARDING) { inclusive = true } } } }
                composable(R.FIRST) {
                    fun enter(then: String?) { vm.finishOnboarding(); nav.navigate(R.HOME) { popUpTo(R.FIRST) { inclusive = true } }; if (then != null) nav.navigate(then) }
                    FirstActionScreen({ enter(if (vm.signedIn) R.DEVICES else R.LOGIN) }, { enter(R.CHECK) }, { enter(R.device(R.THIS_PHONE)) }, { enter(R.LOGIN) })
                }
                composable(R.LOGIN) { LoginScreen(vm, onBack = { back() }, onDone = { back() }) }
                composable(R.HOME) { HomeScreen(vm, ::go) }
                composable(R.DEVICES) { DevicesScreen(vm, ::go, ::back) }
                composable(R.CLEAN) { CleanScreen(vm, ::go) }
                composable(R.SMART) { SmartScanScreen(vm, ::go, ::back) }
                composable("gadget/{id}") { GadgetReportScreen(vm, it.arguments!!.getString("id")!!, ::back, ::go) }
                composable(R.LAB) { LabScreen(vm, ::back, ::go) }
                composable("lab/{id}") { LabTestScreen(vm, it.arguments!!.getString("id")!!, ::back) }
                composable(R.DEAL) { DealScreen(vm, ::back, ::go) }
                composable(R.CHECK) { CheckScreen(vm, ::go) }
                composable(R.RESCUE) { RescueScreen(vm, ::go) }
                composable(R.YOU) { YouScreen(vm, ::go) }
                composable("device/{id}", listOf(navArgument("id") { type = NavType.StringType })) { DeviceDetailScreen(vm, it.arguments!!.getString("id")!!, ::back, ::go) }
                composable("device/{id}/c/{key}") { ComponentDetailScreen(vm, it.arguments!!.getString("id")!!, it.arguments!!.getString("key")!!, ::back, ::go) }
                composable("passport/{id}") { PassportScreen(vm, it.arguments!!.getString("id")!!, ::back) }
                composable("compute/{id}") { ComputeScreen(vm, it.arguments!!.getString("id")!!, ::back) }
                composable("rescue/{id}/{symptom}") {
                    val sym = it.arguments!!.getString("symptom")!!
                    if (sym.isEmpty()) RescueScreen(vm, ::go) else RescueResultScreen(vm, it.arguments!!.getString("id")!!, sym, ::back, ::go)
                }
                composable(R.ALERTS) { AlertsScreen(vm, ::back, ::go) }
                composable(R.PAIR) { LaunchedEffect(vm.pendingOffer) { if (vm.pendingOffer != null) vm.connectOffer { } }; PairScreen(vm, ::back) { nav.navigate(R.SCAN) } }
                composable(R.SCAN) { ScanScreen(vm, ::back) { nav.navigate(R.RESULTS) { popUpTo(R.SCAN) { inclusive = true } } } }
                composable(R.RESULTS) { ResultsScreen(vm, { go(R.PLUS) }, { id -> go(R.gadget(id)) }) { finishCheck() } }
                composable(R.PHONE_TESTS) { PhoneTestsScreen(vm, ::back) }
                composable(R.SETTINGS) { SettingsScreen(vm, ::back) }
                composable(R.PERMISSIONS) { PermissionsScreen(::back) }
                composable(R.CREDITS) { CreditsScreen(::back) }
                composable(R.PLUS) { PlusScreen(vm, ::back) }
                composable(R.TRENDS) { TrendsScreen(vm, ::go, ::back) }
            }
        }
        if (route in tabs.map { it.route }) BottomBar(route!!, ::tab)
    }
}

@Composable private fun BottomBar(current: String, onTab: (String) -> Unit) {
    val d = androidx.compose.ui.platform.LocalDensity.current
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, d.fontScale.coerceAtMost(1.2f))) { BottomBarContent(current, onTab) }
}

@Composable private fun BottomBarContent(current: String, onTab: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().background(Wc.colors.elevated)) {
        Hairline()
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp).padding(top = 8.dp, bottom = 6.dp)) {
            tabs.forEach { t ->
                val on = t.route == current; val tint = if (on) Wc.colors.green else Wc.colors.textSecondary
                val pill by androidx.compose.animation.animateColorAsState(if (on) Wc.colors.green.copy(alpha = .16f) else androidx.compose.ui.graphics.Color.Transparent, androidx.compose.animation.core.tween(220), label = "pill")
                Column(Modifier.weight(1f).selectable(selected = on, role = Role.Tab, onClick = { onTab(t.route) }), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.clip(androidx.compose.foundation.shape.RoundedCornerShape(50)).background(pill).padding(horizontal = 18.dp, vertical = 5.dp)) { WcIcon(t.icon, tint, 24.dp) }
                    Text(t.label, maxLines = 1, softWrap = false, style = Wc.type.meta.copy(fontWeight = if (on) androidx.compose.ui.text.font.FontWeight.SemiBold else androidx.compose.ui.text.font.FontWeight.Medium), color = tint, modifier = Modifier.padding(top = 3.dp))
                }
            }
        }
    }
}
