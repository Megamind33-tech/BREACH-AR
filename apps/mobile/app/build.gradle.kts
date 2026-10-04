plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val packagesDir = rootDir.resolve("../../packages")

android {
    namespace = "com.viro.workcare"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.viro.workcare"
        minSdk = 29               // Android 10
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        // The Control server this build talks to by default; changeable in Settings. Plain http is only accepted for local-network addresses.
        buildConfigField("String", "DEFAULT_SERVER", "\"https://control.viro3.online\"")
    }

    buildTypes {
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-debug" }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.8" }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
    testOptions { unitTests.isReturnDefaultValues = true }
    sourceSets {
        // The shared rule set is the single source of truth; the app evaluates exactly this file.
        getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/shared-assets"))
        getByName("test").resources.srcDir(layout.buildDirectory.dir("generated/shared-vectors"))
    }
}

val copySharedAssets by tasks.registering(Copy::class) {
    from(packagesDir.resolve("health-rules/rules.json")); into(layout.buildDirectory.dir("generated/shared-assets"))
}
val copySharedVectors by tasks.registering(Copy::class) {
    from(packagesDir.resolve("health-rules/vectors.json")); from(packagesDir.resolve("pairing-protocol/vectors.json")) { rename { "wcp1-vectors.json" } }
    from(packagesDir.resolve("health-rules/rules.json"))
    into(layout.buildDirectory.dir("generated/shared-vectors"))
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(copySharedAssets) }
tasks.matching { it.name.contains("UnitTest") && it.name.contains("Resources") }.configureEach { dependsOn(copySharedVectors) }
tasks.matching { it.name.startsWith("process") && it.name.endsWith("UnitTestJavaRes") }.configureEach { dependsOn(copySharedVectors) }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.02.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")

    testImplementation("junit:junit:4.13.2")
    // Unit tests need a real org.json (the Android stubs return defaults). Offline builds use the jar already in the Gradle cache; online builds fetch it.
    val cachedJson = file(System.getProperty("user.home") + "/.gradle/caches/modules-2/files-2.1/org.json/json/20180813/8566b2b0391d9d4479ea225645c6ed47ef17fe41/json-20180813.jar")
    if (cachedJson.exists()) testImplementation(files(cachedJson)) else testImplementation("org.json:json:20231013")
}
