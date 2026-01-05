# TPV Android Specification: Industry Features

## Overview

Modificaciones al TPV Android (AvoqadoPOS) para soportar:

1. Check-in con foto y GPS
2. Ver saldo del promotor
3. Subir comprobante de depósito

---

## Estado Actual

| Componente         | Estado        | Archivo                                |
| ------------------ | ------------- | -------------------------------------- |
| Clock-in/out UI    | ✅ Existe     | `features/timeclock/`                  |
| CameraX            | ✅ Integrado  | `core/presentation/QrScannerScreen.kt` |
| Permisos GPS       | ✅ Declarados | `AndroidManifest.xml`                  |
| Clean Architecture | ✅ Clara      | `features/` pattern                    |

---

## Modificación 1: Check-in con Foto/GPS

### Archivos a Modificar

```
features/timeclock/presentation/clockin/
├── TimeClockScreen.kt      # UI - agregar pasos foto/GPS
├── TimeClockViewModel.kt   # Logic - captura foto/GPS
└── TimeClockUiState.kt     # State - nuevos campos

core/data/network/models/timeentry/
└── ClockInRequest.kt       # Agregar campos
```

### TimeClockUiState.kt

```kotlin
data class TimeClockUiState(
    val clockStatus: ClockStatus = ClockStatus.NOT_CLOCKED_IN,
    val currentTimeEntry: TimeEntry? = null,
    val elapsedTime: String = "00:00:00",
    val isLoading: Boolean = false,
    val error: String? = null,
    val pin: String = "",

    // NUEVO: Estado de check-in verificado
    val checkInStep: CheckInStep = CheckInStep.PIN,
    val capturedPhotoPath: String? = null,
    val capturedLatitude: Double? = null,
    val capturedLongitude: Double? = null,
    val capturedAddress: String? = null,

    // NUEVO: Config de venue
    val requirePhoto: Boolean = false,
    val requireGPS: Boolean = false,
)

enum class CheckInStep {
    PIN,        // Paso 1: Ingresar PIN
    PHOTO,      // Paso 2: Tomar foto (si requirePhoto)
    LOCATION,   // Paso 3: Capturar GPS (si requireGPS)
    CONFIRM     // Paso 4: Confirmar y enviar
}
```

### TimeClockViewModel.kt - Nuevas Funciones

```kotlin
class TimeClockViewModel(
    private val timeEntryRepository: TimeEntryRepository,
    private val sessionManager: SessionManager,
    private val locationClient: FusedLocationProviderClient,  // NUEVO
) : ViewModel() {

    private val _uiState = MutableStateFlow(TimeClockUiState())
    val uiState: StateFlow<TimeClockUiState> = _uiState.asStateFlow()

    // NUEVO: Capturar foto
    fun capturePhoto(bitmap: Bitmap) {
        viewModelScope.launch {
            try {
                _uiState.update { it.copy(isLoading = true) }

                // Guardar foto localmente
                val file = saveBitmapToFile(bitmap)

                _uiState.update {
                    it.copy(
                        capturedPhotoPath = file.absolutePath,
                        checkInStep = if (it.requireGPS) CheckInStep.LOCATION else CheckInStep.CONFIRM,
                        isLoading = false
                    )
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message, isLoading = false) }
            }
        }
    }

    // NUEVO: Obtener ubicación
    @SuppressLint("MissingPermission")
    fun captureLocation() {
        viewModelScope.launch {
            try {
                _uiState.update { it.copy(isLoading = true) }

                locationClient.lastLocation.addOnSuccessListener { location ->
                    if (location != null) {
                        _uiState.update {
                            it.copy(
                                capturedLatitude = location.latitude,
                                capturedLongitude = location.longitude,
                                checkInStep = CheckInStep.CONFIRM,
                                isLoading = false
                            )
                        }
                        // Geocodificar dirección (opcional)
                        geocodeAddress(location.latitude, location.longitude)
                    }
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message, isLoading = false) }
            }
        }
    }

    // MODIFICAR: clockIn existente
    fun clockIn() {
        viewModelScope.launch {
            try {
                _uiState.update { it.copy(isLoading = true) }

                val state = _uiState.value

                // Subir foto si existe
                val photoUrl = state.capturedPhotoPath?.let { path ->
                    uploadPhoto(path)  // Subir a Firebase/S3
                }

                // Llamar API con nuevos campos
                val result = timeEntryRepository.clockIn(
                    venueId = sessionManager.getVenueId() ?: "",
                    staffId = sessionManager.getAvoqadoSession()?.id ?: "",
                    pin = state.pin,
                    photoUrl = photoUrl,
                    latitude = state.capturedLatitude,
                    longitude = state.capturedLongitude,
                )

                // Éxito
                _uiState.update {
                    it.copy(
                        clockStatus = ClockStatus.CLOCKED_IN,
                        currentTimeEntry = result,
                        isLoading = false,
                        checkInStep = CheckInStep.PIN,  // Reset
                        capturedPhotoPath = null,
                        capturedLatitude = null,
                    )
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message, isLoading = false) }
            }
        }
    }

    // Helper: Guardar bitmap a archivo
    private suspend fun saveBitmapToFile(bitmap: Bitmap): File {
        return withContext(Dispatchers.IO) {
            val file = File(context.cacheDir, "checkin_${System.currentTimeMillis()}.jpg")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
            }
            file
        }
    }

    // Helper: Subir foto
    private suspend fun uploadPhoto(path: String): String {
        // Implementar upload a Firebase Storage o S3
        // Retorna URL de la foto
    }
}
```

### TimeClockScreen.kt - UI Modificado

```kotlin
@Composable
fun TimeClockScreen(
    uiState: TimeClockUiState,
    onPinChange: (String) -> Unit,
    onPinSubmit: () -> Unit,
    onCapturePhoto: (Bitmap) -> Unit,
    onCaptureLocation: () -> Unit,
    onClockIn: () -> Unit,
    onNavigateBack: () -> Unit,
) {
    Scaffold(
        topBar = { /* ... */ }
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            when (uiState.checkInStep) {
                CheckInStep.PIN -> {
                    PinEntrySection(
                        pin = uiState.pin,
                        onPinChange = onPinChange,
                        onSubmit = onPinSubmit,
                    )
                }

                CheckInStep.PHOTO -> {
                    PhotoCaptureSection(
                        onCapture = onCapturePhoto,
                    )
                }

                CheckInStep.LOCATION -> {
                    LocationCaptureSection(
                        latitude = uiState.capturedLatitude,
                        longitude = uiState.capturedLongitude,
                        address = uiState.capturedAddress,
                        onCapture = onCaptureLocation,
                    )
                }

                CheckInStep.CONFIRM -> {
                    ConfirmSection(
                        photoPath = uiState.capturedPhotoPath,
                        latitude = uiState.capturedLatitude,
                        longitude = uiState.capturedLongitude,
                        onConfirm = onClockIn,
                    )
                }
            }
        }
    }
}

@Composable
private fun PhotoCaptureSection(
    onCapture: (Bitmap) -> Unit,
) {
    // Reusar patrón de QrScannerScreen pero capturar foto
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    AndroidView(
        factory = { ctx ->
            PreviewView(ctx).apply {
                // Setup CameraX preview
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .height(300.dp)
    )

    Button(
        onClick = { /* Capturar frame actual */ },
        modifier = Modifier.padding(16.dp)
    ) {
        Icon(Icons.Default.CameraAlt, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text("Tomar Foto")
    }
}

@Composable
private fun LocationCaptureSection(
    latitude: Double?,
    longitude: Double?,
    address: String?,
    onCapture: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.padding(16.dp)
    ) {
        Icon(
            Icons.Default.LocationOn,
            contentDescription = null,
            modifier = Modifier.size(64.dp),
            tint = MaterialTheme.colorScheme.primary
        )

        Spacer(Modifier.height(16.dp))

        if (latitude != null && longitude != null) {
            Text("📍 $latitude, $longitude")
            address?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        } else {
            Text("Capturando ubicación...")
            CircularProgressIndicator()
        }

        Spacer(Modifier.height(16.dp))

        Button(onClick = onCapture) {
            Text("Obtener Ubicación")
        }
    }
}
```

### ClockInRequest.kt

```kotlin
data class ClockInRequest(
    @SerializedName("staffId")
    val staffId: String,

    @SerializedName("pin")
    val pin: String,

    @SerializedName("jobRole")
    val jobRole: String? = null,

    // NUEVOS
    @SerializedName("photoUrl")
    val photoUrl: String? = null,

    @SerializedName("latitude")
    val latitude: Double? = null,

    @SerializedName("longitude")
    val longitude: Double? = null,
)
```

---

## Nueva Feature: Balance

### Estructura de Archivos

```
features/balance/
├── data/
│   ├── network/
│   │   ├── BalanceService.kt
│   │   └── models/
│   │       ├── BalanceResponse.kt
│   │       ├── DepositRequest.kt
│   │       └── DepositResponse.kt
│   └── repository/
│       └── BalanceRepositoryImpl.kt
├── domain/
│   ├── models/
│   │   ├── StaffBalance.kt
│   │   └── StaffDeposit.kt
│   └── repository/
│       └── BalanceRepository.kt
└── presentation/
    ├── balance/
    │   ├── BalanceScreen.kt
    │   ├── BalanceViewModel.kt
    │   └── BalanceUiState.kt
    ├── deposit/
    │   ├── DepositUploadScreen.kt
    │   ├── DepositViewModel.kt
    │   └── DepositUiState.kt
    └── navigation/
        └── BalanceNavigation.kt
```

### BalanceService.kt

```kotlin
interface BalanceService {
    @GET("tpv/venues/{venueId}/staff/{staffId}/balance")
    suspend fun getBalance(
        @Path("venueId") venueId: String,
        @Path("staffId") staffId: String,
    ): BalanceResponse

    @Multipart
    @POST("tpv/venues/{venueId}/deposits")
    suspend fun submitDeposit(
        @Path("venueId") venueId: String,
        @Part("staffId") staffId: RequestBody,
        @Part("amount") amount: RequestBody,
        @Part voucher: MultipartBody.Part,
        @Part("notes") notes: RequestBody?,
    ): DepositResponse
}
```

### StaffBalance.kt (Domain Model)

```kotlin
data class StaffBalance(
    val cashBalance: Double,
    val cardBalance: Double,
    val pendingDeposit: Double,
    val totalSales: Double,
    val totalTips: Double,
) {
    val totalBalance: Double
        get() = cashBalance + cardBalance

    val needsDeposit: Boolean
        get() = pendingDeposit > 0
}
```

### BalanceScreen.kt

```kotlin
@Composable
fun BalanceScreen(
    uiState: BalanceUiState,
    onRefresh: () -> Unit,
    onUploadDeposit: () -> Unit,
    onNavigateBack: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Mi Saldo") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Volver")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .padding(16.dp)
        ) {
            // Balance Cards
            BalanceCard(
                title = "Efectivo",
                amount = uiState.balance?.cashBalance ?: 0.0,
                icon = Icons.Default.Money,
                color = Color(0xFF4CAF50)
            )

            Spacer(Modifier.height(12.dp))

            BalanceCard(
                title = "Tarjeta",
                amount = uiState.balance?.cardBalance ?: 0.0,
                icon = Icons.Default.CreditCard,
                color = Color(0xFF2196F3)
            )

            Spacer(Modifier.height(24.dp))

            // Pending Deposit Section
            if (uiState.balance?.needsDeposit == true) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = Color(0xFFFFF3E0)
                    )
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp)
                    ) {
                        Text(
                            "Por Depositar",
                            style = MaterialTheme.typography.labelMedium
                        )
                        Text(
                            "$${uiState.balance.pendingDeposit}",
                            style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFFE65100)
                        )
                    }
                }

                Spacer(Modifier.height(16.dp))

                Button(
                    onClick = onUploadDeposit,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.CameraAlt, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Subir Comprobante")
                }
            }
        }
    }
}

@Composable
private fun BalanceCard(
    title: String,
    amount: Double,
    icon: ImageVector,
    color: Color,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .padding(16.dp)
                .fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(40.dp)
            )
            Spacer(Modifier.width(16.dp))
            Column {
                Text(title, style = MaterialTheme.typography.labelMedium)
                Text(
                    "$${String.format("%.2f", amount)}",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
```

### DepositUploadScreen.kt

```kotlin
@Composable
fun DepositUploadScreen(
    uiState: DepositUiState,
    onAmountChange: (String) -> Unit,
    onCaptureVoucher: (Bitmap) -> Unit,
    onSubmit: () -> Unit,
    onNavigateBack: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Subir Comprobante") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Volver")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .padding(16.dp)
        ) {
            // Monto
            OutlinedTextField(
                value = uiState.amount,
                onValueChange = onAmountChange,
                label = { Text("Monto depositado") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                leadingIcon = { Text("$") },
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(Modifier.height(24.dp))

            // Foto del voucher
            if (uiState.voucherPath != null) {
                AsyncImage(
                    model = uiState.voucherPath,
                    contentDescription = "Comprobante",
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(200.dp)
                        .clip(RoundedCornerShape(8.dp))
                )

                TextButton(onClick = { /* Retomar foto */ }) {
                    Text("Tomar otra foto")
                }
            } else {
                // Camera preview para capturar
                CameraPreview(
                    onCapture = onCaptureVoucher,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(200.dp)
                )
            }

            Spacer(Modifier.weight(1f))

            // Submit button
            Button(
                onClick = onSubmit,
                enabled = uiState.amount.isNotBlank() && uiState.voucherPath != null,
                modifier = Modifier.fillMaxWidth()
            ) {
                if (uiState.isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                } else {
                    Text("Enviar Comprobante")
                }
            }
        }
    }
}
```

---

## Navegación

### Agregar al Menú Principal

```kotlin
// En el drawer o bottom nav del TPV
NavItem(
    icon = Icons.Default.AccountBalance,
    label = "Mi Saldo",
    onClick = { navController.navigate("balance") }
)
```

### Routes

```kotlin
sealed class BalanceDests {
    object Balance : BalanceDests() {
        const val route = "balance"
    }

    object DepositUpload : BalanceDests() {
        const val route = "balance/deposit"
    }
}
```

---

## Permisos Android

Ya declarados en `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

Agregar runtime permission request en las pantallas correspondientes.

---

## Dependencias

Ya incluidas en el proyecto:

- CameraX 1.3.1
- ML Kit (para QR, reutilizable)
- Retrofit 2 (API calls)
- Coil (AsyncImage)

Agregar si no existe:

```gradle
implementation 'com.google.android.gms:play-services-location:21.0.1'
```
