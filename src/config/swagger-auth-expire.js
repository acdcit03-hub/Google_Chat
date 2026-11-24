console.log("Swagger Auth Expire JS Loaded");

window.addEventListener("load", () => {

    const wait = setInterval(() => {

        if (!window.ui) {
            console.log("Waiting for Swagger UI...");
            return;
        }

        clearInterval(wait);

        console.log("Swagger UI Ready");

        // Logout after 7 days
        setTimeout(() => {

            console.log("Logging out...");

            try {
                // Clear Swagger authorization
                window.ui.preauthorizeApiKey("bearerAuth", "");

                // Clear browser storage
                localStorage.clear();
                sessionStorage.clear();

                // Reload page
                window.location.reload();

            } catch (err) {
                console.error(err);
            }

        }, 7 * 24 * 60 * 60 * 1000); // 7 days

    }, 1000);

});