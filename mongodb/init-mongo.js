db.createUser(
  {
    user: "anathema-admin",
    pwd: "anathema-admin-password",
    roles: [
      {
        role: "readWrite",
        db: "anathema"
      }
    ]
  }
);
