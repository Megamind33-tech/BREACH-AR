package com.viro.workcare.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.viro.workcare.AppVm
import com.viro.workcare.photos.PhotoKind
import com.viro.workcare.photos.ResolvedPhoto
import com.viro.workcare.R as Res

// Photographs are used where they carry information: the picture of the actual gadget, and the three onboarding pages. Everything else is typography and plain surfaces.

internal val PhotoInk = Color(0xFFF3F7F4)
internal val PhotoInkSoft = Color(0xFFC7D1CB)
private val PhotoScrim = Color(0xFF060908)

object Pics {
    val laptop = Res.drawable.ph_laptop; val phone = Res.drawable.ph_phone; val board = Res.drawable.ph_board; val glow = Res.drawable.ph_glow
}

/** A photograph with a scrim for text over it (onboarding). */
@Composable fun PhotoBackdrop(@DrawableRes res: Int, modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(CardRadius), scrimBottom: Float = .9f, content: @Composable BoxScope.() -> Unit = {}) {
    Box(modifier.clip(shape)) {
        Image(painterResource(res), null, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
        Box(Modifier.matchParentSize().background(Brush.verticalGradient(0f to Color.Transparent, .5f to PhotoScrim.copy(alpha = scrimBottom * .3f), 1f to PhotoScrim.copy(alpha = scrimBottom))))
        content()
    }
}

/** Just the picture of a gadget, filling its box: landscape photos crop, tall ones sit centred. [description] is what a screen reader says. */
@Composable fun DevicePhotoImage(photo: ResolvedPhoto?, modifier: Modifier = Modifier, description: String? = null, crop: Boolean = false) {
    val bmp = photo?.bitmap
    val m = if (description != null) modifier.semantics { contentDescription = description } else modifier
    Box(m.background(Wc.colors.surface)) {
        if (photo == null) Box(Modifier.fillMaxSize().background(Wc.colors.surface.copy(alpha = .5f)))
        else if (bmp == null) Image(painterResource(if (photo.phone) Pics.phone else Pics.laptop), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else if (crop || bmp.width >= bmp.height * 1.15f) Image(bmp.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Box(Modifier.fillMaxSize().padding(vertical = 16.dp, horizontal = 24.dp), contentAlignment = Alignment.CenterEnd) {   // a tall photo is framed on the right so text can use the left
            Image(bmp.asImageBitmap(), null, Modifier.fillMaxHeight().aspectRatio(bmp.width.toFloat() / bmp.height).clip(RoundedCornerShape(14.dp)), contentScale = ContentScale.Crop)
        }
    }
}

/** The gadget's picture with the plain label that says how close it is to the real thing, and a button to use your own photo. */
@Composable fun DeviceBanner(photo: ResolvedPhoto?, modifier: Modifier = Modifier, height: Dp = 176.dp, name: String? = null, onChange: (() -> Unit)? = null) {
    val shape = RoundedCornerShape(CardRadius)
    Box(modifier.fillMaxWidth().height(height).clip(shape).border(BorderStroke(1.dp, Wc.colors.border), shape)) {
        DevicePhotoImage(photo, Modifier.fillMaxSize(), description = if (name != null) "Picture of $name. ${photo?.kind?.label ?: ""}" else null)
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to PhotoScrim.copy(alpha = .8f))))
        if (photo != null) Column(Modifier.align(Alignment.BottomStart).padding(16.dp)) {
            Text(photo.kind.label, style = Wc.type.meta, color = PhotoInk)
            if (photo.credit != null) Text(photo.credit, style = Wc.type.meta, color = PhotoInkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (onChange != null) Box(Modifier.align(Alignment.TopEnd).padding(8.dp).size(48.dp).clip(CircleShape).background(PhotoScrim.copy(alpha = .6f)).clickable(onClick = onChange, onClickLabel = "Use my own photo").semantics { contentDescription = "Use my own photo of this device" }, contentAlignment = Alignment.Center) { WcIcon(WcIcons.Photo, PhotoInk, 22.dp) }
    }
}

/** Resolves the picture for one gadget in the background (own photo, exact model, similar model, representative). */
@Composable fun rememberDevicePhoto(vm: AppVm, key: String, maker: String?, model: String?, phone: Boolean): ResolvedPhoto? {
    val ver = vm.photoVersion; val look = vm.photoLookup
    return produceState<ResolvedPhoto?>(ResolvedPhoto(PhotoKind.REPRESENTATIVE, null, null, phone), key, maker, model, ver, look) { value = vm.devicePhoto(key, maker, model, phone) }.value
}

/** Opens the system photo chooser (no permission needed) and stores the choice for this gadget. */
@Composable fun rememberPhotoPicker(vm: AppVm, key: String): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? -> if (uri != null) vm.pickPhoto(key, uri) }
    return { launcher.launch("image/*") }
}

/** "HP ProBook 430 G7" -> maker "HP", model "ProBook 430 G7". Names that already start with the maker are not doubled. */
fun makerModel(full: String?): Pair<String?, String?> {
    val t = (full ?: "").trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (t.isEmpty()) return null to null
    return t.first() to t.drop(1).joinToString(" ").ifEmpty { t.first() }
}
